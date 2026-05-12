export interface SongSuggestion {
  title: string
  author?: string
  /** 1–2 line snippet from the chorus to help the user identify the song
   *  at a glance (different "Surrender"s have different lyrics). */
  chorusSnippet?: string
  slots?: string[]
}

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export type AiCandidateDecision = 'pending' | 'shortlist' | 'reject'

/** Structured view of one candidate the SPA is currently holding. The
 *  AI sees the entire pool — pending, shortlisted, rejected, committed —
 *  with stable ids so it can reason about and refer back to specific
 *  entries instead of inferring state from bare title lists. */
export interface AiCandidate {
  id: string
  title: string
  author?: string
  /** 1–2 line snippet from the chorus, when the AI returned one. */
  chorusSnippet?: string
  /** Conceptual roles the AI tagged this candidate with at suggest
   *  time (e.g. "opener", "closer"). */
  slots?: string[]
  decision: AiCandidateDecision
  /** Free-text reason the user gave on reject. Populated once Layer 2
   *  ships the rationale UI; safe to be missing in the meantime. */
  rejectReason?: string
  /** Position info for the service-order slot this candidate is
   *  earmarked for (1-based among song slots). Set whenever the
   *  candidate has an assigned slot, committed or not. The AI can
   *  cross-reference this against the "[song slot N of M]" tags in
   *  the Current service order. */
  assignedSlot?: { index: number; total: number }
  /** True iff the candidate has been committed into Planning Center.
   *  Committed picks also appear inline in the Current service order;
   *  duplicating them here gives the AI an id to address them by. */
  committed?: boolean
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
  /** Full snapshot of the SPA's candidate pool. Supersedes the older
   *  flat shortlistedTitles / rejectedTitles / exclude arrays — the
   *  AI must not re-propose anything in this list. */
  candidates?: AiCandidate[]
  /** Titles of songs already picked in Planning Center that the SPA
   *  doesn't have a candidate record for (e.g. picked manually in PCO
   *  before we started suggesting). The serviceOrder text already
   *  shows them as "picked: <title>"; this array is the
   *  belt-and-suspenders list of titles to never re-suggest. */
  alreadyInPlan?: string[]
  /** Prior chat turns (typed user inputs + synthesised assistant
   *  summaries). The current turn's user message is built fresh on the
   *  server and appended to this history. */
  history?: ConversationTurn[]
  /** Lower bound on the number of suggestions the model should return. */
  minCount?: number
  /** Upper bound on the number of suggestions the model should return. */
  maxCount?: number
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
  name: 'anthropic'
  suggestSongs(req: SuggestRequest): Promise<SuggestResult>
}
