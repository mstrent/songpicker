import { AnthropicProvider } from './anthropic'
import { GeminiProvider } from './gemini'
import { OpenAiProvider } from './openai'
import type { AiProvider } from './types'

export function getAiProvider(name: string, apiKey: string): AiProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(apiKey)
    case 'openai':
      return new OpenAiProvider(apiKey)
    case 'gemini':
      return new GeminiProvider(apiKey)
    default:
      throw new Error(`Unknown AI provider: ${name}`)
  }
}

export type { AiProvider, SongSuggestion, SuggestRequest } from './types'
