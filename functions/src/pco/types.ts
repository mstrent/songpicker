export interface ServiceType {
  id: string
  name: string | null
}

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

export interface NewItem {
  title: string
  sequence: number
  itemType: 'song' | 'header' | 'media' | 'item'
  songId?: string
}
