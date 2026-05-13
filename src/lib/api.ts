import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

export interface TeamMember {
  name: string
  email: string | null
  position: string | null
  team: string | null
}

export interface SongCounts {
  filled: number
  total: number
}

export interface Plan {
  id: string
  serviceTypeId: string
  serviceTypeName: string | null
  title: string | null
  seriesTitle: string | null
  sortDate: string | null
  teamMembers?: TeamMember[]
  songCounts?: SongCounts
}

export interface PlanNote {
  id: string
  content: string
  category: string | null
}

export interface ItemNote {
  content: string
}

export interface PlanItem {
  id: string
  sequence: number
  title: string
  itemType: string
  songId: string | null
  songTitle: string | null
  songAuthor: string | null
  songCcli: string | null
  arrangementId: string | null
  keyId: string | null
  keyName: string | null
  description: string | null
  notes: ItemNote[]
  leaders: string[]
}

export interface Song {
  id: string
  title: string
  author: string | null
  ccliNumber: string | null
  themes: string | null
  isHidden: boolean
  lastScheduledAt: string | null
  lastScheduledShortDates: string | null
}

export interface SongSuggestion {
  title: string
  author?: string
  chorusSnippet?: string
  slots?: string[]
}


export interface CommitItem {
  title: string
  sequence: number
  itemType: 'song' | 'header' | 'media' | 'item'
  songId?: string
}

export const getPcoStatus = httpsCallable<void, { hasCredentials: boolean }>(
  functions,
  'getPcoStatus',
)

export const savePcoCredentials = httpsCallable<
  { appId: string; secret: string },
  { ok: boolean }
>(functions, 'savePcoCredentials')

export const listPlans = httpsCallable<void, { plans: Plan[] }>(functions, 'listPlans')

export const getPlanContext = httpsCallable<
  { serviceTypeId: string; planId: string },
  {
    plan: Plan
    notes: PlanNote[]
    items: PlanItem[]
    userTheme: string
    userNotes: string
    /** Per-plan map of song-slot itemId → the placeholder title PCO
     *  had on that slot the last time we observed it empty. Server
     *  reconciles on every plan load so the SPA always sees the
     *  freshest captured value. Empty for slots we've never seen
     *  empty (e.g., the slot was filled in PCO before songpicker
     *  first opened the plan) — those fall back to "Song N". */
    slotPlaceholders: Record<string, string>
  }
>(functions, 'getPlanContext')

export const savePlanTheme = httpsCallable<
  { planId: string; theme: string },
  { ok: boolean }
>(functions, 'savePlanTheme')

export const savePlanNotes = httpsCallable<
  { planId: string; notes: string },
  { ok: boolean }
>(functions, 'savePlanNotes')

export type MatchStatus = 'checking' | 'matched' | 'unmatched' | 'error'
export type Decision = 'pending' | 'reject'

export interface PersistedSongRef {
  id: string
  title: string
  lastScheduledAt: string | null
  lastScheduledShortDates: string | null
}

export interface PersistedCandidate {
  id: string
  title: string
  author: string | null
  chorusSnippet: string | null
  slots: string[]
  matchStatus: MatchStatus
  song: PersistedSongRef | null
  error: string | null
  decision: Decision
  addedAt: number
  assignedSlotItemId: string | null
  committedAt: number | null
  /** Title the PCO item had before this candidate was committed to it.
   *  Captured at commit time so a later "clear" can restore the slot
   *  title (otherwise it stays as the song name forever). Null on
   *  uncommitted candidates and on candidates persisted before this
   *  field existed. */
  priorSlotTitle: string | null
}

export interface SessionMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export interface PickerSession {
  candidates: PersistedCandidate[]
  messages: SessionMessage[]
}

export const loadSession = httpsCallable<{ planId: string }, PickerSession>(
  functions,
  'loadSession',
)

export const saveSession = httpsCallable<
  { planId: string; session: PickerSession },
  { ok: boolean }
>(functions, 'saveSession')

/** Intent-shaped placement endpoint. Use this for all
 *  "ensure this song is in this slot" intents — fresh commits AND
 *  moves. When fromSlotItemId is provided, the old slot is cleared
 *  first (PCO has no atomic move). */
export const placeSongInSlot = httpsCallable<
  {
    serviceTypeId: string
    planId: string
    slotItemId: string
    songId: string
    songTitle?: string
    /** When set, the function first clears this slot before
     *  committing to slotItemId. Used for move semantics. */
    fromSlotItemId?: string
    /** Title to restore on the from-slot when clearing it. */
    fromSlotRestoreTitle?: string
  },
  { ok: boolean }
>(functions, 'placeSongInSlot')

/** Intent-shaped clear endpoint. */
export const clearSongFromSlot = httpsCallable<
  {
    serviceTypeId: string
    planId: string
    slotItemId: string
    restoreTitle?: string
  },
  { ok: boolean }
>(functions, 'clearSongFromSlot')

export const reorderItems = httpsCallable<
  {
    serviceTypeId: string
    planId: string
    /** The plan's items in their NEW desired order. The server PATCHes
     *  each one with sequence = index + 1. */
    orderedItemIds: string[]
  },
  { ok: boolean }
>(functions, 'reorderItems')

export interface SongArrangement {
  id: string
  name: string
  chordChartKey: string | null
  keys: { id: string; name: string }[]
}

export const listSongArrangements = httpsCallable<
  { songId: string },
  { arrangements: SongArrangement[] }
>(functions, 'listSongArrangements')

export const setSlotArrangementKey = httpsCallable<
  {
    serviceTypeId: string
    planId: string
    itemId: string
    arrangementId: string
    keyId?: string | null
  },
  { ok: boolean }
>(functions, 'setSlotArrangementKey')

export const searchSongs = httpsCallable<
  { query: string; author?: string },
  { songs: Song[] }
>(functions, 'searchSongs')

/** Bulk variant for the AI propose flow. Each input query maps to
 *  a `Song[]` (or `null` when the query was blank) at the same
 *  index in `results`. */
export const searchSongsBatch = httpsCallable<
  { queries: Array<{ query: string; author?: string }> },
  { results: Array<Song[] | null> }
>(functions, 'searchSongsBatch')

export type PromptType = 'structure' | 'role'
export type PromptSource = 'plan' | 'user' | 'system'

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

/** Structured candidate snapshot sent to the AI on every suggest call.
 *  Matches AiCandidate in functions/src/ai/types.ts. The AI sees the
 *  whole pool (pending, shortlisted, rejected, committed) with stable
 *  ids so it can reason about specific entries rather than inferring
 *  state from bare title arrays. */
export interface AiCandidate {
  id: string
  title: string
  author?: string
  chorusSnippet?: string
  slots?: string[]
  decision: Decision
  assignedSlot?: { index: number; total: number }
  committed?: boolean
  /** True iff the candidate has a matched song in the user's
   *  Planning Center library. Only library-matched candidates can be
   *  committed; the AI checks this when planning commits. */
  inLibrary?: boolean
}

/** Actions the AI emitted on a turn — Anthropic tool calls translated
 *  to a discriminated union the SPA applies directly. Mirrors
 *  AiAction in functions/src/ai/types.ts. */
export interface ProposeAction {
  kind: 'propose'
  suggestions: SongSuggestion[]
}
export interface RemoveAction {
  kind: 'remove'
  ids: string[]
}
export interface SlotAssignment {
  slotIndex: number
  candidateId: string | null
}
export interface SetSlotContentsAction {
  kind: 'set_slot_contents'
  assignments: SlotAssignment[]
}
export interface UnrejectAction {
  kind: 'unreject'
  ids: string[]
}
export type AiAction =
  | ProposeAction
  | RemoveAction
  | SetSlotContentsAction
  | UnrejectAction

/** One progress chunk streamed as the AI turn unfolds. Text deltas
 *  append to the in-progress assistant message; action chunks are
 *  applied immediately so candidates / removals / reassignments
 *  appear in the UI as soon as the model commits to them. */
export type StreamChunk =
  | { kind: 'text'; delta: string }
  | { kind: 'action'; action: AiAction }

export interface SuggestRequest {
  theme: string
  userMessage: string
  planId?: string
  serviceOrder?: string
  planNotes?: string
  history?: ConversationTurn[]
  candidates?: AiCandidate[]
  alreadyInPlan?: string[]
  /** Set when the SPA fired this call after a state change rather
   *  than user-typed input. Switches the AI into a terse mode. */
  autoRefresh?: boolean
}

export interface SuggestResponse {
  actions: AiAction[]
  message: string
  structureSource: PromptSource
  roleSource: PromptSource
}

export const suggestSongs = httpsCallable<
  SuggestRequest,
  SuggestResponse,
  StreamChunk
>(functions, 'suggestSongs')

export interface PromptConfig {
  builtIn: string
  userDefault: string
  planOverride: string
  effective: { value: string; source: PromptSource }
}

export const getPromptConfig = httpsCallable<
  { type: PromptType; planId?: string },
  PromptConfig
>(functions, 'getPromptConfig')

export const savePromptConfig = httpsCallable<
  { type: PromptType; scope: 'default' | 'plan'; planId?: string; value: string },
  { ok: boolean; builtIn: string }
>(functions, 'savePromptConfig')

export interface AdminPromptConfig {
  structure: { admin: string; hardcoded: string }
  role: { admin: string; hardcoded: string }
  technical: string
  /** Hardcoded prompt content the admin can't edit but should be able
   *  to inspect: the four tool descriptions sent to the model on every
   *  turn, plus the per-turn nudge appended when an auto-refresh fires
   *  (no typed user input). All read-only. */
  tooling: {
    tools: { name: string; description: string }[]
    autoRefreshNudge: string
  }
}

export const getAdminStatus = httpsCallable<void, { isAdmin: boolean }>(
  functions,
  'getAdminStatus',
)

export const getAdminPromptConfig = httpsCallable<void, AdminPromptConfig>(
  functions,
  'getAdminPromptConfig',
)

export const saveAdminPromptConfig = httpsCallable<
  { type: PromptType; value: string },
  { ok: boolean }
>(functions, 'saveAdminPromptConfig')

export const commitPlanItems = httpsCallable<
  { serviceTypeId: string; planId: string; items: CommitItem[] },
  { created: number }
>(functions, 'commitPlanItems')

/** Access-list management. The `env` lists come from ALLOWED_EMAIL /
 *  ADMIN_EMAILS in functions/.env and are read-only break-glass roots
 *  — surfaced for transparency, not editable. The `stored` lists live
 *  in Firestore and are what the admin manages from the UI. The
 *  effective allowlist is `env ∪ stored`. */
export type AccessList = 'allowed' | 'admin'

export interface AccessConfig {
  env: { allowedEmails: string[]; adminEmails: string[] }
  stored: { allowedEmails: string[]; adminEmails: string[] }
}

export const getAccessConfig = httpsCallable<void, AccessConfig>(
  functions,
  'getAccessConfig',
)

export const addAccessEntry = httpsCallable<
  { list: AccessList; entry: string },
  { stored: { allowedEmails: string[]; adminEmails: string[] } }
>(functions, 'addAccessEntry')

export const removeAccessEntry = httpsCallable<
  { list: AccessList; entry: string },
  { stored: { allowedEmails: string[]; adminEmails: string[] } }
>(functions, 'removeAccessEntry')
