import type { SongSuggestion, SuggestRequest } from './types'

// Single source of truth for the user-side text sent to the AI. Keeps the
// three providers (Anthropic, Gemini, OpenAI) in lockstep on what each
// suggestion call looks like, and is what the SPA debug panel surfaces.
//
// The chat history (prior user/assistant turns) carries the user's typed
// inputs; this function only builds the LATEST turn, including the
// current plan state. So past turns stay short and readable, while the
// current turn has all the context the model needs to act.
export function buildUserMessage(req: SuggestRequest): string {
  const count = req.count ?? 8
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
  if (req.shortlistedTitles?.length) {
    parts.push(`Already shortlisted: ${req.shortlistedTitles.join(', ')}`)
  }
  if (req.rejectedTitles?.length) {
    parts.push(`Already rejected: ${req.rejectedTitles.join(', ')}`)
  }
  parts.push(`User request: ${req.userMessage || '(none)'}`)
  parts.push(`Return at least ${count} suggestions.`)
  if (req.exclude?.length) {
    parts.push(
      `\nDo NOT suggest any of these (already considered): ${req.exclude.join(', ')}`,
    )
  }
  return parts.join('\n')
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
