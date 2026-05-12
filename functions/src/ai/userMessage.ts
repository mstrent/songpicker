import type { AiCandidate, SuggestRequest } from './types'

/** Two-part user message: the `stable` half (theme + plan notes +
 *  structure + service order) tends not to change between turns of
 *  the same session, so it gets a cache_control breakpoint in the
 *  Anthropic request. The `volatile` half (candidates + alreadyInPlan
 *  + the user's latest typed input) is fresh every turn and lives
 *  past the cache boundary. */
export interface BuiltUserMessage {
  stable: string
  volatile: string
}

// Single source of truth for the user-side text the AI sees on the
// current turn. The chat history (prior user/assistant turns) carries
// the user's typed inputs and the AI's prose replies; this function
// only assembles the LATEST turn, including a fresh snapshot of plan
// state so the AI always reasons against current reality.
export function buildUserMessage(req: SuggestRequest): BuiltUserMessage {
  const stableParts: string[] = [`Theme: ${req.theme}`]
  if (req.planNotes && req.planNotes.trim()) {
    stableParts.push(`Plan notes:\n${req.planNotes.trim()}`)
  }
  if (req.structurePrompt && req.structurePrompt.trim()) {
    stableParts.push(`Service structure: ${req.structurePrompt.trim()}`)
  }
  if (req.serviceOrder && req.serviceOrder.trim()) {
    stableParts.push(`Current service order:\n${req.serviceOrder.trim()}`)
  }

  const volatileParts: string[] = []
  if (req.candidates && req.candidates.length > 0) {
    volatileParts.push(`Current candidates:\n${renderCandidates(req.candidates)}`)
  }
  if (req.alreadyInPlan && req.alreadyInPlan.length > 0) {
    volatileParts.push(
      `Already in plan (don't re-suggest): ${req.alreadyInPlan.join(', ')}`,
    )
  }
  volatileParts.push(`User request: ${req.userMessage || '(none)'}`)
  if (req.autoRefresh) {
    // Override the system prompt's "make it short, conversational,
    // and explanatory" guidance for this specific turn. The user
    // adjusted state but didn't ask anything — chat output should
    // be minimal so they aren't interrupted by a paragraph after
    // every reject.
    volatileParts.push(
      "[auto-refresh] This turn was fired automatically after the user adjusted state without asking anything. Be terse: at most ONE short sentence in your text reply, or none at all — let the action markers speak. Don't summarise what you did. Only call propose_songs if a still-unfilled role's options have actually dropped below 2; otherwise prefer doing nothing.",
    )
  }

  return {
    stable: stableParts.join('\n'),
    volatile: volatileParts.join('\n'),
  }
}

/** Flat-string form for the SPA debug panel and any caller that
 *  doesn't care about the cache boundary. */
export function flattenUserMessage(b: BuiltUserMessage): string {
  return [b.stable, b.volatile].filter((s) => s).join('\n')
}

// One line per candidate, dense enough for the AI to scan and address
// any entry by id. Mirrors the SPA's mental model (decision + optional
// slot earmark + chorus snippet for disambiguation) without leaking
// purely internal fields like matchStatus or addedAt.
function renderCandidates(candidates: AiCandidate[]): string {
  return candidates
    .map((c) => {
      const parts: string[] = [`  ${c.id} — "${c.title}"`]
      if (c.author) parts.push(`(${c.author})`)
      parts.push(`— ${decisionLabel(c)}`)
      if (c.inLibrary === false) {
        parts.push(`— NOT IN LIBRARY (can't be committed via set_slot_contents)`)
      }
      if (c.assignedSlot) {
        parts.push(
          `— earmarked for song slot ${c.assignedSlot.index} of ${c.assignedSlot.total}`,
        )
      }
      if (c.slots && c.slots.length > 0) {
        parts.push(`— tagged: ${c.slots.join(', ')}`)
      }
      if (c.chorusSnippet) {
        parts.push(`— chorus: "${c.chorusSnippet}"`)
      }
      if (c.rejectReason) {
        parts.push(`— reason: "${c.rejectReason}"`)
      }
      return parts.join(' ')
    })
    .join('\n')
}

function decisionLabel(c: AiCandidate): string {
  if (c.committed) return 'committed'
  switch (c.decision) {
    case 'reject':
      return 'rejected'
    case 'pending':
    default:
      return 'pending'
  }
}
