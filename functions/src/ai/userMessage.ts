import type { AiCandidate, SongSuggestion, SuggestRequest } from './types'

// Single source of truth for the user-side text sent to the AI. Keeps the
// three providers (Anthropic, Gemini, OpenAI) in lockstep on what each
// suggestion call looks like, and is what the SPA debug panel surfaces.
//
// The chat history (prior user/assistant turns) carries the user's typed
// inputs; this function only builds the LATEST turn, including the
// current plan state. So past turns stay short and readable, while the
// current turn has all the context the model needs to act.
export function buildUserMessage(req: SuggestRequest): string {
  // Sensible defaults if the caller didn't specify a range — match the old
  // single-count fallback (8) as a soft upper bound and pin a min of 4.
  const rawMin = req.minCount ?? 4
  const rawMax = req.maxCount ?? 8
  const minCount = Math.max(1, Math.min(rawMin, rawMax))
  const maxCount = Math.max(minCount, rawMax)
  const parts: string[] = [
    `Theme: ${req.theme}`,
  ]
  if (req.planNotes && req.planNotes.trim()) {
    parts.push(`Plan notes:\n${req.planNotes.trim()}`)
  }
  if (req.structurePrompt && req.structurePrompt.trim()) {
    parts.push(`Service structure: ${req.structurePrompt.trim()}`)
  }
  if (req.serviceOrder && req.serviceOrder.trim()) {
    parts.push(`Current service order:\n${req.serviceOrder.trim()}`)
  }
  if (req.candidates && req.candidates.length > 0) {
    parts.push(`Current candidates:\n${renderCandidates(req.candidates)}`)
  }
  if (req.alreadyInPlan && req.alreadyInPlan.length > 0) {
    parts.push(`Already in plan (don't re-suggest): ${req.alreadyInPlan.join(', ')}`)
  }
  parts.push(`User request: ${req.userMessage || '(none)'}`)
  if (minCount === maxCount) {
    parts.push(`Return exactly ${minCount} suggestion${minCount === 1 ? '' : 's'}.`)
  } else {
    parts.push(
      `Return between ${minCount} and ${maxCount} suggestions — stay within this range.`,
    )
  }
  return parts.join('\n')
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
    case 'shortlist':
      return 'shortlisted'
    case 'reject':
      return 'rejected'
    case 'pending':
    default:
      return 'pending'
  }
}

// Compact rendering of "what I just suggested" for the chat log and for
// echoing back as a prior assistant turn. Includes slot tags when present.
export function buildAssistantSummary(suggestions: SongSuggestion[]): string {
  if (suggestions.length === 0) return 'No suggestions returned.'
  const lines = suggestions.map((s) => {
    const author = s.author ? ` — ${s.author}` : ''
    const slots = s.slots && s.slots.length > 0 ? `  (${s.slots.join(', ')})` : ''
    return `• ${s.title}${author}${slots}`
  })
  return `Suggested ${suggestions.length} song${suggestions.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
}
