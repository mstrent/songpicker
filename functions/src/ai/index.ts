import { AnthropicProvider } from './anthropic'
import type { AiProvider } from './types'

// Single-provider for now (Anthropic / Claude Sonnet 4.6). The AiProvider
// abstraction is kept intentionally so a future provider can be added
// without rewiring callers — wire it up here when that day comes.
export function getAiProvider(apiKey: string): AiProvider {
  return new AnthropicProvider(apiKey)
}

export type {
  AiAction,
  AiCandidate,
  AiDebug,
  AiProvider,
  ClearSlotAction,
  CommitSongAction,
  ProposeAction,
  ReassignAction,
  RemoveAction,
  SongSuggestion,
  StreamChunk,
  SuggestRequest,
  SuggestResult,
  UnrejectAction,
} from './types'
