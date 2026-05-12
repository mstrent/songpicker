import Anthropic from '@anthropic-ai/sdk'
import { buildUserMessage, flattenUserMessage } from './userMessage'
import type {
  AiAction,
  AiProvider,
  ClearSlotAction,
  CommitSongAction,
  ProposeAction,
  RemoveAction,
  SongSuggestion,
  StreamChunk,
  SuggestRequest,
  SuggestResult,
  UnrejectAction,
} from './types'

const MODEL = 'claude-sonnet-4-6'

// Three tools the model can invoke per turn (any combination, in any
// order, or none). Schemas are intentionally permissive on optional
// fields so the model isn't forced to fabricate values it doesn't have.
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_songs',
    description:
      "Add one or more new song suggestions to the candidate pool. Each suggestion needs a title; author, chorusSnippet, and slots are optional but recommended. The user sees these as new cards in the AI candidates list.",
    input_schema: {
      type: 'object',
      properties: {
        suggestions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              author: { type: 'string' },
              chorusSnippet: {
                type: 'string',
                description:
                  '1-2 recognisable lines from the chorus, under 100 chars. Helps the user disambiguate songs sharing a title. Omit if you genuinely do not know the lyrics.',
              },
              slots: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Conceptual role names from the structure prompt (e.g. "opener", "mid-service", "closer"). Not position labels like "song slot 2".',
              },
            },
            required: ['title'],
          },
        },
      },
      required: ['suggestions'],
    },
  },
  {
    name: 'remove_candidates',
    description:
      "Mark one or more existing candidates as rejected. Use this when context (user feedback, theme shift, role saturation) makes a prior suggestion obviously wrong. The reason is shown to the user in the rejected pool.",
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Candidate ids drawn from the "Current candidates" block in the user message.',
        },
        reason: {
          type: 'string',
          description:
            'Short, user-facing reason. Phrase from the AI\'s perspective ("doesn\'t fit the new theme"), not the user\'s.',
        },
      },
      required: ['ids', 'reason'],
    },
  },
  {
    name: 'commit_song',
    description:
      "Fill a Planning Center song slot with this candidate. Use only when the user has clearly directed you to ('commit X to slot 2', 'fill the closer with the second one', 'go ahead and pick that'). Don't commit during auto-refresh turns and don't commit unprompted. The candidate must be matched to a song in the user's PCO library (committed candidates show up as 'committed' in the candidates block); if the user wants to commit something the AI proposed earlier this turn, wait for the user to confirm. Move semantics: if the candidate is already committed to a different slot, the SPA clears that slot automatically as part of the move — just call commit_song with the new slot. Don't issue a separate clear_slot for moves.",
    input_schema: {
      type: 'object',
      properties: {
        candidateId: { type: 'string' },
        slotIndex: {
          type: 'integer',
          minimum: 1,
          description:
            'Target song slot, 1-based, matching the [song slot N of M] tags in the service order text.',
        },
      },
      required: ['candidateId', 'slotIndex'],
    },
  },
  {
    name: 'clear_slot',
    description:
      "Back out an already-committed song slot in Planning Center. Use when the user asks you to clear/unpick/undo a slot. Don't clear during auto-refresh turns and don't clear unprompted.",
    input_schema: {
      type: 'object',
      properties: {
        slotIndex: {
          type: 'integer',
          minimum: 1,
          description: '1-based song slot to clear.',
        },
      },
      required: ['slotIndex'],
    },
  },
  {
    name: 'unreject_candidates',
    description:
      "Reverse a prior remove_candidates: flip the listed candidates back from rejected to pending. Use to course-correct when you removed something you shouldn't have, or when the user asks to bring rejected entries back.",
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Candidate ids from the Current candidates block.',
        },
      },
      required: ['ids'],
    },
  },
]

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async suggestSongs(
    req: SuggestRequest,
    onChunk?: (chunk: StreamChunk) => void | Promise<void>,
  ): Promise<SuggestResult> {
    const built = buildUserMessage(req)
    const systemPrompt = req.systemPrompt
    const history = req.history ?? []

    // Cache_control breakpoints: one on the system prompt (constant per
    // session), one on the stable half of the current user turn (theme
    // + notes + structure + service order — these change rarely
    // mid-session). Anthropic caches up through each breakpoint and
    // serves the matching prefix on subsequent turns. Below the 1024-
    // token cache minimum the markers are no-ops; above it, savings
    // compound across a conversation.
    const params: Anthropic.MessageCreateParams = {
      model: MODEL,
      max_tokens: 4000,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        ...history.map((t) => ({ role: t.role, content: t.content })),
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: built.stable,
              cache_control: { type: 'ephemeral' as const },
            },
            { type: 'text' as const, text: built.volatile },
          ],
        },
      ],
    }

    // Track whether any chunks have actually streamed back. Used to
    // decide whether a content-filter retry is safe: if we already
    // forwarded text to the client, retrying would double-emit it.
    let chunksSent = 0
    const trackedOnChunk = onChunk
      ? async (c: StreamChunk) => {
          chunksSent += 1
          await onChunk(c)
        }
      : undefined

    const runStream = async (): Promise<SuggestResult> => {
      const stream = this.client.messages.stream(params)
      // Buffer partial tool_use inputs keyed by content-block index;
      // input_json_delta events stream in as fragments and we have to
      // concatenate before parsing.
      const toolBuffers = new Map<number, { name: string; json: string }>()
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            toolBuffers.set(event.index, {
              name: event.content_block.name,
              json: '',
            })
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            if (trackedOnChunk) {
              await trackedOnChunk({ kind: 'text', delta: event.delta.text })
            }
          } else if (event.delta.type === 'input_json_delta') {
            const buf = toolBuffers.get(event.index)
            if (buf) buf.json += event.delta.partial_json
          }
        } else if (event.type === 'content_block_stop') {
          const buf = toolBuffers.get(event.index)
          if (buf) {
            const action = safeBuildAction(buf.name, buf.json)
            if (action && trackedOnChunk)
              await trackedOnChunk({ kind: 'action', action })
          }
        }
      }
      const finalMessage = await stream.finalMessage()
      const { actions, message, rawActions } = parseResponse(finalMessage.content)
      return {
        actions,
        message: message || fallbackMessage(actions),
        debug: {
          model: MODEL,
          systemPrompt,
          userMessage: flattenUserMessage(built),
          rawActions,
        },
      }
    }

    // Stream the response so the SPA can show the AI's prose reply as
    // it types and apply each tool_use the moment it completes. The
    // final aggregated message is still parsed for the return value,
    // so non-streaming callers behave the same.
    //
    // Retry once on content-filter errors. Anthropic's output filter
    // is non-deterministic — a second generation of the same prompt
    // often passes when the first fails. Only safe to retry when no
    // chunks have streamed yet, otherwise the client would see
    // duplicated text. Content-filter blocks normally trigger before
    // the first delta, so the retry path is the common case.
    try {
      return await runStream()
    } catch (e) {
      if (chunksSent === 0 && isContentFilterError(e)) {
        console.warn(
          '[anthropic] content filter blocked output; retrying once',
        )
        try {
          return await runStream()
        } catch (e2) {
          if (isContentFilterError(e2)) {
            throw new Error(
              "Anthropic's safety filter blocked the response twice in a row. This is usually transient — try again, or rephrase your request.",
            )
          }
          throw e2
        }
      }
      throw e
    }
  }
}

// Anthropic's content filter surfaces in a few wrapper shapes
// depending on whether the block hits the request or the streaming
// output. Match by message text since the SDK doesn't expose a
// specific error class for this. We unwrap `cause` recursively
// because the stream SDK wraps the SSE error in an APIConnectionError.
function isContentFilterError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const err = e as { message?: string; cause?: unknown }
  const msg = err.message ?? ''
  if (/content[ _-]?filter/i.test(msg) || /blocked by content/i.test(msg)) {
    return true
  }
  if (err.cause && err.cause !== err) {
    return isContentFilterError(err.cause)
  }
  return false
}

interface ParseOutput {
  actions: AiAction[]
  message: string
  rawActions: unknown[]
}

// Final-message parsing. Same code path the non-streaming version used
// to take — runs once we've consumed the stream so the SPA can be given
// a complete actions[] in the callable's return value too (in addition
// to the streamed per-action chunks).
function parseResponse(content: Anthropic.ContentBlock[]): ParseOutput {
  const textChunks: string[] = []
  const actions: AiAction[] = []
  const rawActions: unknown[] = []

  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.trim()) textChunks.push(block.text.trim())
      continue
    }
    if (block.type !== 'tool_use') continue
    rawActions.push({ name: block.name, input: block.input })
    const action = toAction(block.name, block.input)
    if (action) actions.push(action)
  }

  return {
    actions,
    message: textChunks.join('\n\n'),
    rawActions,
  }
}

function safeBuildAction(name: string, partialJson: string): AiAction | null {
  // Empty input is valid for tools with no required fields, but our
  // three all require at least one field so empty json never produces
  // a usable action.
  if (!partialJson.trim()) return null
  try {
    const input = JSON.parse(partialJson)
    return toAction(name, input)
  } catch {
    return null
  }
}

function toAction(name: string, input: unknown): AiAction | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  switch (name) {
    case 'propose_songs':
      return parsePropose(obj)
    case 'remove_candidates':
      return parseRemove(obj)
    case 'commit_song':
      return parseCommit(obj)
    case 'clear_slot':
      return parseClear(obj)
    case 'unreject_candidates':
      return parseUnreject(obj)
    default:
      return null
  }
}

function parsePropose(obj: Record<string, unknown>): ProposeAction | null {
  if (!Array.isArray(obj.suggestions)) return null
  const suggestions: SongSuggestion[] = []
  for (const raw of obj.suggestions) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.title !== 'string' || !r.title.trim()) continue
    suggestions.push({
      title: r.title.trim(),
      author: typeof r.author === 'string' ? r.author : undefined,
      chorusSnippet:
        typeof r.chorusSnippet === 'string' ? r.chorusSnippet : undefined,
      slots: Array.isArray(r.slots)
        ? r.slots.filter((s): s is string => typeof s === 'string')
        : undefined,
    })
  }
  if (suggestions.length === 0) return null
  return { kind: 'propose', suggestions }
}

function parseRemove(obj: Record<string, unknown>): RemoveAction | null {
  if (!Array.isArray(obj.ids)) return null
  const ids = obj.ids.filter(
    (i): i is string => typeof i === 'string' && i.length > 0,
  )
  if (ids.length === 0) return null
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim()
      ? obj.reason.trim()
      : 'no longer fits'
  return { kind: 'remove', ids, reason }
}

function parseCommit(obj: Record<string, unknown>): CommitSongAction | null {
  if (typeof obj.candidateId !== 'string' || !obj.candidateId) return null
  const idx = typeof obj.slotIndex === 'number' ? Math.floor(obj.slotIndex) : NaN
  if (!Number.isFinite(idx) || idx < 1) return null
  return { kind: 'commit', candidateId: obj.candidateId, slotIndex: idx }
}

function parseClear(obj: Record<string, unknown>): ClearSlotAction | null {
  const idx = typeof obj.slotIndex === 'number' ? Math.floor(obj.slotIndex) : NaN
  if (!Number.isFinite(idx) || idx < 1) return null
  return { kind: 'clear_slot', slotIndex: idx }
}

function parseUnreject(obj: Record<string, unknown>): UnrejectAction | null {
  if (!Array.isArray(obj.ids)) return null
  const ids = obj.ids.filter(
    (i): i is string => typeof i === 'string' && i.length > 0,
  )
  if (ids.length === 0) return null
  return { kind: 'unreject', ids }
}

// If the model called tools but emitted no prose text, synthesize a
// short status line so the chat log doesn't have a blank assistant
// turn. Verb-neutral on purpose: the server can't tell a fresh
// commit from a move (the SPA decides at apply time), so we count
// total changes instead of naming each kind. The per-action 🤖
// system messages carry the accurate detail.
function fallbackMessage(actions: AiAction[]): string {
  if (actions.length === 0) return 'No changes this turn.'
  const total = actions.reduce((sum, a) => {
    if (a.kind === 'propose') return sum + a.suggestions.length
    if (a.kind === 'remove') return sum + a.ids.length
    if (a.kind === 'unreject') return sum + a.ids.length
    return sum + 1
  }, 0)
  return `Done — ${total} change${total === 1 ? '' : 's'}.`
}
