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

export interface AiDebug {
  model: string
  systemPrompt: string
  userMessage: string
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
export type Decision = 'pending' | 'shortlist' | 'reject'

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
  /** Free-text reason the user gave when rejecting this candidate.
   *  Null on un-rejected candidates and on rejected ones with no
   *  reason provided. Surfaced to the AI on the next suggest call. */
  rejectReason: string | null
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

export const commitSlot = httpsCallable<
  {
    serviceTypeId: string
    planId: string
    itemId: string
    songId: string
    /** Sent so the PCO item title is rewritten to match the song name —
     *  Planning Center's web UI does this automatically when you link a
     *  song, but the API doesn't. */
    songTitle?: string
  },
  { ok: boolean }
>(functions, 'commitSlot')

export const clearSlot = httpsCallable<
  {
    serviceTypeId: string
    planId: string
    itemId: string
    /** Title to PATCH onto the item alongside clearing the song. Used to
     *  revert the title that the prior commit overwrote with the song
     *  name — caller passes the stored prior title or a "Song N"
     *  fallback. */
    title?: string
  },
  { ok: boolean }
>(functions, 'clearSlot')

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

export const searchSongs = httpsCallable<{ query: string }, { songs: Song[] }>(
  functions,
  'searchSongs',
)

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
  rejectReason?: string
  assignedSlot?: { index: number; total: number }
  committed?: boolean
}

export const suggestSongs = httpsCallable<
  {
    theme: string
    userMessage: string
    minCount?: number
    maxCount?: number
    planId?: string
    serviceOrder?: string
    planNotes?: string
    history?: ConversationTurn[]
    candidates?: AiCandidate[]
    alreadyInPlan?: string[]
  },
  {
    suggestions: SongSuggestion[]
    debug: AiDebug
    assistantMessage: string
    structureSource: PromptSource
    roleSource: PromptSource
  }
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

/** A reason chip in the global rejection-reasons list. `source` tracks
 *  where the chip came from: 'seed' (baked-in defaults), 'manual'
 *  (typed by a user), 'ai' (distilled from freeform reasons). */
export interface CommonReason {
  text: string
  addedAt: number
  source: 'manual' | 'ai' | 'seed'
}

export interface RejectionReasonsView {
  common: CommonReason[]
  freeformSinceDistill: number
  lastDistilledAt: number
}

export const getRejectionReasons = httpsCallable<void, RejectionReasonsView>(
  functions,
  'getRejectionReasons',
)

export const recordRejectReason = httpsCallable<
  { reason: string },
  RejectionReasonsView
>(functions, 'recordRejectReason')

export const removeCommonReason = httpsCallable<
  { text: string },
  RejectionReasonsView
>(functions, 'removeCommonReason')
