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

/** Appended to the volatile half when the SPA fires a turn
 *  automatically (no typed user input). Overrides the system prompt's
 *  default "be conversational" guidance so an auto-refresh doesn't
 *  interrupt the user with a paragraph after every reject. Exported so
 *  the admin endpoint can surface it read-only alongside the tool
 *  descriptions. */
export const AUTO_REFRESH_NUDGE =
  "[auto-refresh] This turn was fired automatically after the user adjusted state without asking anything. Be terse: at most ONE short sentence in your text reply, or none at all — let the action markers speak. Don't summarise what you did. Only call propose_songs if a still-unfilled role's options have actually dropped below 2; otherwise prefer doing nothing."

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
    volatileParts.push(AUTO_REFRESH_NUDGE)
  }

  return {
    stable: stableParts.join('\n'),
    volatile: volatileParts.join('\n'),
  }
}

// One line per candidate. Stratified by decision to keep the volatile
// block small in long sessions:
//   committed → id, title, author, "— committed→slot N" (service order
//     already shows everything else about this song)
//   rejected  → id, title, author, "— rejected"
//   pending   → full content (the AI is actively reasoning here)
// `author` always goes through regardless of decision — worship song
// titles are often ambiguous ("Way Maker", "How Great Is Our God") and
// the AI needs the disambiguator. Same for the user reading the chat.
function renderCandidates(candidates: AiCandidate[]): string {
  return candidates.map(renderCandidate).join('\n')
}

function renderCandidate(c: AiCandidate): string {
  const parts: string[] = [`  ${c.id} — "${c.title}"`]
  if (c.author) parts.push(`(${c.author})`)

  if (c.committed) {
    if (c.assignedSlot) {
      parts.push(`— committed → slot ${c.assignedSlot.index} of ${c.assignedSlot.total}`)
    } else {
      parts.push('— committed')
    }
    return parts.join(' ')
  }

  if (c.decision === 'reject') {
    parts.push('— rejected')
    return parts.join(' ')
  }

  parts.push('— pending')
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
  return parts.join(' ')
}
