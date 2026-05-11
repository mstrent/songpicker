import { getFirestore } from 'firebase-admin/firestore'

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
  /** PCO item id this candidate is queued to fill, or null. */
  assignedSlotItemId: string | null
  /** Epoch ms when this assignment was successfully committed to PCO. */
  committedAt: number | null
  /** PCO item title at commit time, before we overwrote it with the
   *  song name. Lets a later "clear" restore the original slot label
   *  instead of leaving the song name behind. */
  priorSlotTitle: string | null
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export interface PickerSession {
  candidates: PersistedCandidate[]
  messages: Message[]
}

function emptySession(): PickerSession {
  return { candidates: [], messages: [] }
}

function sanitizeCandidate(raw: unknown): PersistedCandidate | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  if (typeof c.id !== 'string' || typeof c.title !== 'string') return null
  const decision = c.decision === 'shortlist' || c.decision === 'reject' ? c.decision : 'pending'
  const matchStatus =
    c.matchStatus === 'matched' || c.matchStatus === 'unmatched' || c.matchStatus === 'error'
      ? c.matchStatus
      : 'checking'
  return {
    id: c.id,
    title: c.title,
    author: typeof c.author === 'string' ? c.author : null,
    chorusSnippet:
      typeof c.chorusSnippet === 'string'
        ? c.chorusSnippet
        : typeof c.reasoning === 'string'
          ? c.reasoning
          : null,
    slots: Array.isArray(c.slots)
      ? c.slots.filter((s): s is string => typeof s === 'string')
      : [],
    matchStatus,
    song:
      c.song && typeof c.song === 'object'
        ? sanitizeSong(c.song as Record<string, unknown>)
        : null,
    error: typeof c.error === 'string' ? c.error : null,
    decision,
    addedAt: typeof c.addedAt === 'number' ? c.addedAt : Date.now(),
    assignedSlotItemId:
      typeof c.assignedSlotItemId === 'string' ? c.assignedSlotItemId : null,
    committedAt: typeof c.committedAt === 'number' ? c.committedAt : null,
    priorSlotTitle:
      typeof c.priorSlotTitle === 'string' ? c.priorSlotTitle : null,
  }
}

function sanitizeSong(raw: Record<string, unknown>): PersistedSongRef | null {
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return null
  return {
    id: raw.id,
    title: raw.title,
    lastScheduledAt:
      typeof raw.lastScheduledAt === 'string' ? raw.lastScheduledAt : null,
    lastScheduledShortDates:
      typeof raw.lastScheduledShortDates === 'string'
        ? raw.lastScheduledShortDates
        : null,
  }
}

function sanitizeMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || typeof m.content !== 'string') return null
  if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') return null
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
  }
}

const ref = (uid: string, planId: string) =>
  getFirestore().doc(`pickerSessions/${uid}/plans/${planId}`)

export async function loadPickerSession(
  uid: string,
  planId: string,
): Promise<PickerSession> {
  const snap = await ref(uid, planId).get()
  if (!snap.exists) return emptySession()
  const data = snap.data() ?? {}
  const candidates = Array.isArray(data.candidates)
    ? data.candidates
        .map(sanitizeCandidate)
        .filter((c): c is PersistedCandidate => !!c)
    : []
  const messages = Array.isArray(data.messages)
    ? data.messages.map(sanitizeMessage).filter((m): m is Message => !!m)
    : []
  return { candidates, messages }
}

export async function savePickerSession(
  uid: string,
  planId: string,
  session: PickerSession,
): Promise<void> {
  await ref(uid, planId).set(
    {
      candidates: session.candidates,
      messages: session.messages,
      updatedAt: new Date(),
    },
    { merge: false },
  )
}
