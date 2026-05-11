export interface ServiceType {
  id: string
  name: string | null
}

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

export interface PlanPerson {
  id: string
  name: string | null
  position: string | null
  status: string | null
  email: string | null
  team: string | null
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
  arrangementName: string | null
  keyName: string | null
  description: string | null
  notes: ItemNote[]
  leaders: string[]
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
