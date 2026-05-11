export interface SongSuggestion {
  title: string
  author?: string
  reasoning?: string
}

export interface SuggestRequest {
  theme: string
  criteria: string
  exclude?: string[]
  count?: number
}

export interface AiProvider {
  name: 'anthropic' | 'openai'
  suggestSongs(req: SuggestRequest): Promise<SongSuggestion[]>
}
