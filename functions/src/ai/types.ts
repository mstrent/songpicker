export interface SongSuggestion {
  title: string
  author?: string
  chorusSnippet?: string
  snippetSource?: 'lrclib' | 'haiku-extract' | 'haiku-generate'
  slots?: string[]
}

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export type AiCandidateDecision = 'pending' | 'reject'

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
  /** True iff the candidate has been successfully matched to a song
   *  in the user's Planning Center library. Only library-matched
   *  candidates can be committed via set_slot_contents — the AI
   *  should check this before planning commits and fall back to a
   *  different candidate (or explain to the user) when their first
   *  pick isn't matched. */
  inLibrary?: boolean
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
  /** True when this call was fired automatically by the SPA after the
   *  user adjusted state (rejected songs) without typing anything.
   *  Switches the user-message builder into a terse mode that nudges
   *  the model toward silent tool calls and a one-sentence-max reply,
   *  since the user didn't ask for a chat. */
  autoRefresh?: boolean
}

/** Add new candidates to the pool. The SPA appends these the same way
 *  user-driven Suggest used to: each suggestion becomes a pending
 *  CandidateMatch and goes through library-match lookup. */
export interface ProposeAction {
  kind: 'propose'
  suggestions: SongSuggestion[]
}

/** Mark existing candidates as rejected. Same downstream effect as the
 *  user clicking Reject, except the system message tags the move as
 *  AI-driven. */
export interface RemoveAction {
  kind: 'remove'
  ids: string[]
}

/** A single slot assignment: "this slot should contain this candidate"
 *  (or null to be empty). Multiple assignments in one call cover any
 *  multi-slot rearrangement — fresh commit, move, swap, overwrite,
 *  clear — without the AI needing to choose between specialized
 *  tools or coordinate multiple tool calls. */
export interface SlotAssignment {
  slotIndex: number
  candidateId: string | null
}

/** Declarative slot-state update: place candidates in slots, with
 *  null meaning "empty this slot". Replaces the older
 *  commit_song / clear_slot pair. The SPA computes the diff from
 *  current state and runs the PCO operations in two phases (clears
 *  then commits) so swaps and moves land cleanly. */
export interface SetSlotContentsAction {
  kind: 'set_slot_contents'
  assignments: SlotAssignment[]
}

/** Reverse a prior remove_candidates: flip the listed candidates back
 *  out of rejected and into pending. Lets the AI walk back a mistake
 *  in the same conversation. */
export interface UnrejectAction {
  kind: 'unreject'
  ids: string[]
}

export type AiAction =
  | ProposeAction
  | RemoveAction
  | SetSlotContentsAction
  | UnrejectAction

export interface SuggestResult {
  /** Ordered list of actions the AI chose to take this turn. Applied
   *  by the SPA in order; each action also emits a system message in
   *  the chat log so the user sees what changed. */
  actions: AiAction[]
  /** The AI's prose reply for this turn — drawn from the text content
   *  block of its tool-use response. Empty/whitespace falls back to a
   *  generic synthesized message so the chat log never goes silent. */
  message: string
}

/** A single piece of progress streamed back to the client as the AI
 *  turn unfolds. Two shapes:
 *   - `text`: a delta fragment of the model's prose reply, appended to
 *     the assistant chat message as it arrives.
 *   - `action`: a fully-decoded tool_use block ready to apply.
 *  The full SuggestResult is still returned at the end of the call,
 *  so non-streaming clients see the same shape they always did. */
export type StreamChunk =
  | { kind: 'text'; delta: string }
  | { kind: 'action'; action: AiAction }

/** One-shot per-song classification call. Used when a song lands in
 *  the candidate pool via slot eviction (not via AI proposal) — we
 *  have title/author from Planning Center but no AI-derived metadata
 *  (slot tags, chorus snippet). The classifier reads the same plan
 *  context the main suggester sees and returns:
 *   - 1-3 short slot-position labels (vocabulary from structure prompt)
 *   - an optional 1-2 line chorus snippet (omitted when Haiku is
 *     uncertain rather than fabricated). */
export interface ClassifySongRequest {
  songTitle: string
  songAuthor?: string
  /** CCLI number from Planning Center, when available. Surfaced to
   *  the model alongside title + author because single-word worship
   *  titles ("Surrender", "Hallelujah") collide heavily across
   *  catalogues — CCLI is the unambiguous industry identifier and
   *  reminds the model that this is a specific licensed song. */
  songCcli?: string
  theme?: string
  planNotes?: string
  structurePrompt?: string
  serviceOrder?: string
}

export interface ClassifySongResult {
  slots: string[]
  chorusSnippet?: string
}

export interface AiProvider {
  name: 'anthropic'
  suggestSongs(
    req: SuggestRequest,
    onChunk?: (chunk: StreamChunk) => void | Promise<void>,
  ): Promise<SuggestResult>
  classifySongSlots(req: ClassifySongRequest): Promise<ClassifySongResult>
}
