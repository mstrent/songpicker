export interface SongSuggestion {
  title: string
  author?: string
  reasoning?: string
  slots?: string[]
}

export interface SuggestRequest {
  theme: string
  criteria: string
  structurePrompt?: string
  systemPrompt: string
  /** Pre-formatted, human-readable list of the plan's items showing
   *  filled vs empty song slots. Built on the SPA side from PlanItem[]
   *  and passed through verbatim so the AI sees position context. */
  serviceOrder?: string
  exclude?: string[]
  count?: number
}

export interface AiDebug {
  model: string
  systemPrompt: string
  userMessage: string
}

export interface SuggestResult {
  suggestions: SongSuggestion[]
  debug: AiDebug
}

export interface AiProvider {
  name: 'anthropic' | 'openai' | 'gemini'
  suggestSongs(req: SuggestRequest): Promise<SuggestResult>
}
