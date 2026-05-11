export interface SongSuggestion {
  title: string
  author?: string
  reasoning?: string
}

export interface SuggestRequest {
  theme: string
  criteria: string
  structurePrompt?: string
  systemPrompt: string
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
