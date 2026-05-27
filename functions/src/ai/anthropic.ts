import Anthropic from '@anthropic-ai/sdk'
import { buildUserMessage, formatPlanContextLines } from './userMessage'
import type {
  AiAction,
  AiProvider,
  ClassifySongRequest,
  ClassifySongResult,
  ProposeAction,
  RemoveAction,
  SetSlotContentsAction,
  SlotAssignment,
  SongSuggestion,
  StreamChunk,
  SuggestRequest,
  SuggestResult,
  UnrejectAction,
} from './types'

const MODEL = 'claude-sonnet-4-6'

// Shared chorus-snippet discipline embedded in the tool descriptions
// that can produce a snippet: propose_songs (main suggester) and
// classify_song (eviction-mint). The classifier's system prompt used
// to ALSO embed this; we removed that duplication because:
//   1. system + tool description was redundant, and
//   2. concrete song names in the negative examples were
//      pattern-priming the model to bleed those very names into its
//      output (Sonnet was emitting "Withholding nothing" — a phrase
//      from our negative example — as a snippet for unrelated songs).
// Rules now stay abstract: no concrete song titles or author names
// that can become positive cues by accident. Single source of truth
// — update here, both flows pick it up. Surfaced read-only on the
// Admin page via the existing tooling payload.
// Chorus snippets are no longer AI-sourced — they come from LRCLIB
// via the enrichSnippets callable. The classifier only returns slot
// labels now; Haiku is sufficient for that task.
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'

const SONG_SLOTS_FIELD = {
  type: 'array' as const,
  items: { type: 'string' as const },
  description:
    'Conceptual role names drawn from the structure prompt (e.g. "opener", "mid-service", "closer", "communion", "response"). Lowercase short noun phrases — NOT position labels like "song slot 2".',
}

export const CLASSIFY_SONG_TOOL: Anthropic.Tool = {
  name: 'classify_song',
  description:
    'Return slot-position labels for the given song.',
  input_schema: {
    type: 'object',
    properties: {
      slots: { ...SONG_SLOTS_FIELD, minItems: 1, maxItems: 3 },
    },
    required: ['slots'],
  },
}

export const CLASSIFY_SONG_SYSTEM = `You analyze worship songs for placement within a service plan. Given a song (title + author, sometimes CCLI) and the service structure, call the classify_song tool with 1–3 short slot-position labels — lowercase noun phrases drawn from the structure prompt's vocabulary (e.g. "opener", "mid-service", "closer"). Not sentences.`

// 1-hour cache TTL on the system + stable user prefixes. Worship-leader
// sessions routinely span 30-90 minutes of bursty work — the default
// 5-minute cache expires between turns and we pay full price on the
// cached prefix repeatedly. 1h writes cost ~2x per token but reads are
// the same, so any session with ≥2 turns in the hour wins. The SDK's
// CacheControlEphemeral type doesn't yet include `ttl`; the API does.
const CACHE_1H = { type: 'ephemeral' as const, ttl: '1h' } as unknown as
  Anthropic.CacheControlEphemeral

// Tools the model can invoke per turn (any combination, in any order,
// or none). Schemas are intentionally permissive on optional fields so
// the model isn't forced to fabricate values it doesn't have. Exported
// so the admin endpoint can surface the descriptions read-only.
export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_songs',
    description:
      "Add one or more new song suggestions to the candidate pool. Each suggestion needs a title; author and slots are optional but recommended. The user sees these as new cards in the AI candidates list.",
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
              slots: SONG_SLOTS_FIELD,
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
      "Mark one or more existing candidates as rejected. Use this when context (user feedback, theme shift, role saturation) makes a prior suggestion obviously wrong. If you want to explain why, do it in your prose reply alongside this tool call — the rejection itself doesn't carry a per-candidate reason.",
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Candidate ids drawn from the "Current candidates" block in the user message.',
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'set_slot_contents',
    description:
      "Declarative slot-state update for Planning Center. Pass an array of assignments — each specifies what one song slot should contain after the call. This single tool covers every slot rearrangement: fresh commit, move, swap, overwrite, and clear. The SPA computes the diff from the current service order and runs the necessary PCO operations as one atomic batch.\n\nWhen to use: any user-directed action that changes what's in a slot. 'Commit X to slot 2', 'move X to slot 4', 'swap X and Y', 'clear the closer' — all map to one call to this tool with the appropriate assignments.\n\nRules: don't use during auto-refresh turns. Don't write to Planning Center unprompted. Non-null candidateIds must reference a candidate that's matched to a song in the user's library (committed candidates and library-matched proposals from prior turns are eligible; freshly-proposed candidates from this same turn won't be matched yet).\n\nExamples (slotIndex is 1-based among song slots, matching the '[song slot N of M]' tags):\n- Commit candidate c_abc to song slot 2:\n  assignments=[{slotIndex:2, candidateId:'c_abc'}]\n- Move candidate c_abc from its current slot to slot 4 — just specify the target; the SPA infers the source clear:\n  assignments=[{slotIndex:4, candidateId:'c_abc'}]\n- Clear song slot 2 (remove whatever song is there):\n  assignments=[{slotIndex:2, candidateId:null}]\n- Swap two committed songs A (currently slot 1) and B (currently slot 3):\n  assignments=[{slotIndex:1, candidateId:'c_B'}, {slotIndex:3, candidateId:'c_A'}]\n- Fill two empty slots in one go:\n  assignments=[{slotIndex:2, candidateId:'c_X'}, {slotIndex:4, candidateId:'c_Y'}]",
    input_schema: {
      type: 'object',
      properties: {
        assignments: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              slotIndex: {
                type: 'integer',
                minimum: 1,
                description:
                  '1-based song-slot position, matching the [song slot N of M] tags in the service order text.',
              },
              candidateId: {
                type: ['string', 'null'],
                description:
                  'Candidate id from the Current candidates block, or null to clear the slot.',
              },
            },
            required: ['slotIndex', 'candidateId'],
          },
        },
      },
      required: ['assignments'],
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
    // Opt in to the extended cache-TTL beta so the `ttl: '1h'` on our
    // cache_control breakpoints is honoured. Harmless if the feature
    // has GA'd by the time you read this — Anthropic ignores beta flags
    // for features that are already generally available.
    this.client = new Anthropic({
      apiKey,
      defaultHeaders: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' },
    })
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
    // mid-session). Both use a 1-hour TTL (see CACHE_1H above) so the
    // prefix survives across the bursty pauses typical of a planning
    // session.
    const params: Anthropic.MessageCreateParams = {
      model: MODEL,
      max_tokens: 4000,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      system: [
        { type: 'text', text: systemPrompt, cache_control: CACHE_1H },
      ],
      messages: [
        ...history.map((t) => ({ role: t.role, content: t.content })),
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: built.stable,
              cache_control: CACHE_1H,
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
      const { actions, message } = parseResponse(finalMessage.content)
      return {
        actions,
        message: message || fallbackMessage(actions),
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
              { cause: e2 },
            )
          }
          throw e2
        }
      }
      throw e
    }
  }

  async classifySongSlots(
    req: ClassifySongRequest,
  ): Promise<ClassifySongResult> {
    // Plan-context section uses the shared formatter — same output as
    // the main suggester's stable prefix, so the two flows can't drift.
    const userParts = formatPlanContextLines(req)
    const idParts: string[] = [`"${req.songTitle}"`]
    if (req.songAuthor) idParts.push(`by ${req.songAuthor}`)
    if (req.songCcli) idParts.push(`(CCLI ${req.songCcli})`)
    userParts.push(`Classify this song:\n${idParts.join(' ')}`)

    const response = await this.client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 300,
      system: CLASSIFY_SONG_SYSTEM,
      tools: [CLASSIFY_SONG_TOOL],
      tool_choice: { type: 'tool', name: 'classify_song' },
      messages: [{ role: 'user', content: userParts.join('\n\n') }],
    })

    for (const block of response.content) {
      if (block.type !== 'tool_use' || block.name !== 'classify_song') continue
      const input = block.input as { slots?: unknown }
      const slots = Array.isArray(input.slots)
        ? input.slots
            .filter((s): s is string => typeof s === 'string')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .slice(0, 3)
        : []
      if (slots.length > 0) {
        return { slots }
      }
    }
    // Forced tool call should always produce a result, but be defensive
    // — empty slots is preferable to throwing and breaking the
    // enrichment flow.
    return { slots: [] }
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
}

// Final-message parsing. Same code path the non-streaming version used
// to take — runs once we've consumed the stream so the SPA can be given
// a complete actions[] in the callable's return value too (in addition
// to the streamed per-action chunks).
function parseResponse(content: Anthropic.ContentBlock[]): ParseOutput {
  const textChunks: string[] = []
  const actions: AiAction[] = []

  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.trim()) textChunks.push(block.text.trim())
      continue
    }
    if (block.type !== 'tool_use') continue
    const action = toAction(block.name, block.input)
    if (action) actions.push(action)
  }

  return {
    actions,
    message: textChunks.join('\n\n'),
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
    case 'set_slot_contents':
      return parseSetSlotContents(obj)
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
  return { kind: 'remove', ids }
}

function parseSetSlotContents(
  obj: Record<string, unknown>,
): SetSlotContentsAction | null {
  if (!Array.isArray(obj.assignments)) return null
  const assignments: SlotAssignment[] = []
  for (const raw of obj.assignments) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const idx = typeof r.slotIndex === 'number' ? Math.floor(r.slotIndex) : NaN
    if (!Number.isFinite(idx) || idx < 1) continue
    let candidateId: string | null
    if (r.candidateId === null) candidateId = null
    else if (typeof r.candidateId === 'string' && r.candidateId.trim())
      candidateId = r.candidateId
    else continue
    assignments.push({ slotIndex: idx, candidateId })
  }
  if (assignments.length === 0) return null
  return { kind: 'set_slot_contents', assignments }
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
// turn. The per-action 🤖 system messages carry the detail; the
// prose line just needs to mark the turn as finished.
function fallbackMessage(actions: AiAction[]): string {
  if (actions.length === 0) return 'No changes this turn.'
  return 'Done.'
}
