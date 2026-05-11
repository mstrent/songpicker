import type { SuggestRequest } from './types'

// Single source of truth for the user-side text sent to the AI. Keeps the
// three providers (Anthropic, Gemini, OpenAI) in lockstep on what each
// suggestion call looks like, and is what the SPA debug panel surfaces.
export function buildUserMessage(req: SuggestRequest): string {
  const count = req.count ?? 8
  const parts = [
    `Theme: ${req.theme}`,
    `Criteria: ${req.criteria || '(none)'}`,
  ]
  if (req.structurePrompt && req.structurePrompt.trim()) {
    parts.push(`Service structure: ${req.structurePrompt.trim()}`)
  }
  parts.push(`Return ${count} suggestions.`)
  if (req.exclude?.length) {
    parts.push(
      `\nDo NOT suggest any of these (already considered): ${req.exclude.join(', ')}`,
    )
  }
  return parts.join('\n')
}
