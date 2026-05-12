import Anthropic from '@anthropic-ai/sdk'
import { buildUserMessage } from './userMessage'
import type {
  AiAction,
  AiProvider,
  ProposeAction,
  ReassignAction,
  RemoveAction,
  SongSuggestion,
  SuggestRequest,
  SuggestResult,
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
    name: 'reassign',
    description:
      "Move a candidate's earmark to a different song slot in the service order. slotIndex is 1-based among song slots and corresponds to the '[song slot N of M]' tags in the service order text.",
    input_schema: {
      type: 'object',
      properties: {
        candidateId: { type: 'string' },
        slotIndex: { type: 'integer', minimum: 1 },
      },
      required: ['candidateId', 'slotIndex'],
    },
  },
]

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async suggestSongs(req: SuggestRequest): Promise<SuggestResult> {
    const userMessage = buildUserMessage(req)
    const systemPrompt = req.systemPrompt
    const history = req.history ?? []
    const res = await this.client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      tools: TOOLS,
      // Free the model to chat, call tools, or both. Forcing tool use
      // every turn would prevent purely-conversational replies.
      tool_choice: { type: 'auto' },
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user' as const, content: userMessage },
      ],
    })

    const { actions, message, rawActions } = parseResponse(res.content)
    return {
      actions,
      message: message || fallbackMessage(actions),
      debug: { model: MODEL, systemPrompt, userMessage, rawActions },
    }
  }
}

interface ParseOutput {
  actions: AiAction[]
  message: string
  rawActions: unknown[]
}

// Anthropic returns content as a mix of `text` and `tool_use` blocks.
// We collect text into the prose reply and translate tool_use blocks
// into our AiAction discriminated union. Unknown tool names and
// malformed inputs are silently skipped so a single bad block doesn't
// blank the whole turn.
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

function toAction(name: string, input: unknown): AiAction | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  switch (name) {
    case 'propose_songs':
      return parsePropose(obj)
    case 'remove_candidates':
      return parseRemove(obj)
    case 'reassign':
      return parseReassign(obj)
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

function parseReassign(obj: Record<string, unknown>): ReassignAction | null {
  if (typeof obj.candidateId !== 'string' || !obj.candidateId) return null
  const idx = typeof obj.slotIndex === 'number' ? Math.floor(obj.slotIndex) : NaN
  if (!Number.isFinite(idx) || idx < 1) return null
  return { kind: 'reassign', candidateId: obj.candidateId, slotIndex: idx }
}

// If the model called tools but emitted no prose text, synthesize a
// short status line so the chat log doesn't have a blank assistant
// turn. Keeps the conversation visibly responsive.
function fallbackMessage(actions: AiAction[]): string {
  if (actions.length === 0) return 'No changes this turn.'
  const counts = {
    proposed: 0,
    removed: 0,
    reassigned: 0,
  }
  for (const a of actions) {
    if (a.kind === 'propose') counts.proposed += a.suggestions.length
    else if (a.kind === 'remove') counts.removed += a.ids.length
    else if (a.kind === 'reassign') counts.reassigned += 1
  }
  const parts: string[] = []
  if (counts.proposed)
    parts.push(`proposed ${counts.proposed} song${counts.proposed === 1 ? '' : 's'}`)
  if (counts.removed)
    parts.push(`removed ${counts.removed} candidate${counts.removed === 1 ? '' : 's'}`)
  if (counts.reassigned)
    parts.push(`reassigned ${counts.reassigned} slot${counts.reassigned === 1 ? '' : 's'}`)
  return `Done — ${parts.join(', ')}.`
}
