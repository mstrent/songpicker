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
  reasoning?: string
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
  reasoning: string | null
  slots: string[]
  matchStatus: MatchStatus
  song: PersistedSongRef | null
  error: string | null
  decision: Decision
  addedAt: number
  assignedSlotItemId: string | null
  committedAt: number | null
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
  { serviceTypeId: string; planId: string; itemId: string; songId: string },
  { ok: boolean }
>(functions, 'commitSlot')

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

export const suggestSongs = httpsCallable<
  {
    theme: string
    userMessage: string
    exclude?: string[]
    count?: number
    planId?: string
    serviceOrder?: string
    planNotes?: string
    history?: ConversationTurn[]
    shortlistedTitles?: string[]
    rejectedTitles?: string[]
  },
  {
    suggestions: SongSuggestion[]
    provider: string
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
