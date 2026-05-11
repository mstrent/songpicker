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
}

export interface CommitItem {
  title: string
  sequence: number
  itemType: 'song' | 'header' | 'media' | 'item'
  songId?: string
}

export const listPlans = httpsCallable<void, { plans: Plan[] }>(functions, 'listPlans')

export const getPlanContext = httpsCallable<
  { serviceTypeId: string; planId: string },
  { plan: Plan; notes: PlanNote[]; items: PlanItem[] }
>(functions, 'getPlanContext')

export const searchSongs = httpsCallable<{ query: string }, { songs: Song[] }>(
  functions,
  'searchSongs',
)

export const suggestSongs = httpsCallable<
  { theme: string; criteria: string; exclude?: string[]; count?: number },
  { suggestions: SongSuggestion[]; provider: string }
>(functions, 'suggestSongs')

export const commitPlanItems = httpsCallable<
  { serviceTypeId: string; planId: string; items: CommitItem[] },
  { created: number }
>(functions, 'commitPlanItems')
