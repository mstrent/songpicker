export interface SongSuggestion {
  title: string
  author?: string
  reasoning?: string
  slots?: string[]
}

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface SuggestRequest {
  /** The user's latest typed input — initial criteria on first turn, a
   *  refinement on subsequent turns. */
  userMessage: string
  theme: string
  structurePrompt?: string
  systemPrompt: string
  /** Pre-formatted, human-readable list of the plan's items showing
   *  filled vs empty song slots. Built on the SPA side from PlanItem[]
   *  and passed through verbatim so the AI sees position context. */
  serviceOrder?: string
  /** Pre-formatted, human-readable plan notes (sermon theme, scripture,
   *  general notes, etc.) from Planning Center. */
  planNotes?: string
  /** Titles already in PCO or already suggested — model should not
   *  return any of these again. */
  exclude?: string[]
  /** Titles the user has actively shortlisted. Surfaced as state in the
   *  current user message so the model can reason around them. */
  shortlistedTitles?: string[]
  /** Titles the user has rejected. Same state surface as shortlisted. */
  rejectedTitles?: string[]
  /** Prior chat turns (typed user inputs + synthesised assistant
   *  summaries). The current turn's user message is built fresh on the
   *  server and appended to this history. */
  history?: ConversationTurn[]
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
  /** Short, human-readable summary of what the model suggested. Goes
   *  into the chat log on the SPA side and is echoed back as a prior
   *  assistant turn on subsequent calls. */
  assistantMessage: string
}

export interface AiProvider {
  name: 'anthropic' | 'openai' | 'gemini'
  suggestSongs(req: SuggestRequest): Promise<SuggestResult>
}
