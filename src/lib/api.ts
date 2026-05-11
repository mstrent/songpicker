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

export interface PlanItem {
  id: string
  sequence: number
  title: string
  itemType: string
  songId: string | null
  songTitle: string | null
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
  { plan: Plan; notes: PlanNote[]; items: PlanItem[]; userTheme: string }
>(functions, 'getPlanContext')

export const savePlanTheme = httpsCallable<
  { planId: string; theme: string },
  { ok: boolean }
>(functions, 'savePlanTheme')

export const searchSongs = httpsCallable<{ query: string }, { songs: Song[] }>(
  functions,
  'searchSongs',
)

export type PromptType = 'structure' | 'role'
export type PromptSource = 'plan' | 'user' | 'system'

export const suggestSongs = httpsCallable<
  {
    theme: string
    criteria: string
    exclude?: string[]
    count?: number
    planId?: string
  },
  {
    suggestions: SongSuggestion[]
    provider: string
    debug: AiDebug
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

export const commitPlanItems = httpsCallable<
  { serviceTypeId: string; planId: string; items: CommitItem[] },
  { created: number }
>(functions, 'commitPlanItems')
