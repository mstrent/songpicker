import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

export interface Plan {
  id: string
  serviceTypeId: string
  title: string | null
  seriesTitle: string | null
  sortDate: string | null
}

export interface PlanNote {
  id: string
  content: string
  category: string | null
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
  { notes: PlanNote[] }
>(functions, 'getPlanContext')

export const searchSongs = httpsCallable<{ query: string }, { songs: Song[] }>(
  functions,
  'searchSongs',
)

export const suggestSongs = httpsCallable<
  { theme: string; criteria: string; exclude?: string[]; count?: number },
  { suggestions: SongSuggestion[] }
>(functions, 'suggestSongs')

export const commitPlanItems = httpsCallable<
  { serviceTypeId: string; planId: string; items: CommitItem[] },
  { created: number }
>(functions, 'commitPlanItems')
