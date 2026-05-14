import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'

export const METRIC_ACTIONS = [
  'signIns',
  'plansOpened',
  'aiSuggestions',
  'slotCommits',
  'slotClears',
] as const

export type MetricAction = (typeof METRIC_ACTIONS)[number]

export interface StoredMetrics {
  email?: string
  firstSeenAt?: Timestamp
  lastSeenAt?: Timestamp
  signIns?: number
  plansOpened?: number
  aiSuggestions?: number
  slotCommits?: number
  slotClears?: number
}

// Pure helper — returns the Firestore merge payload for one bump.
// `existing` is null when the doc doesn't exist yet; that's when we
// set `firstSeenAt`. Everything else (email mirror, lastSeenAt,
// counter increment) happens on every write.
export function buildMetricUpdate(
  existing: StoredMetrics | null,
  action: MetricAction,
  email: string,
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    email,
    lastSeenAt: FieldValue.serverTimestamp(),
    [action]: FieldValue.increment(1),
  }
  if (!existing) {
    update.firstSeenAt = FieldValue.serverTimestamp()
  }
  return update
}

// View shape returned to the Admin SPA. Timestamps are serialized to
// ISO strings because callable responses can't carry Timestamp objects.
export interface UserMetricsView {
  uid: string
  email: string
  firstSeenAt: string | null
  lastSeenAt: string | null
  signIns: number
  plansOpened: number
  aiSuggestions: number
  slotCommits: number
  slotClears: number
}

// Fire-and-forget on the calling side. Wrapped in try/catch so a
// flaky Firestore write never propagates into the user-facing
// callable. Logs a warning so failures aren't silent in function
// logs.
export async function recordMetric(
  uid: string,
  email: string,
  action: MetricAction,
): Promise<void> {
  try {
    const db = getFirestore()
    const ref = db.collection('metrics').doc(uid)
    const snap = await ref.get()
    const existing = snap.exists ? (snap.data() as StoredMetrics) : null
    await ref.set(buildMetricUpdate(existing, action, email), { merge: true })
  } catch (err) {
    console.warn('[metrics] write failed:', err)
  }
}

// Admin-page read. Sorted by lastSeenAt descending so the most
// recently active user is at the top. Missing fields default to
// 0 / null so the SPA can render a uniform table.
export async function loadAllMetrics(): Promise<UserMetricsView[]> {
  const db = getFirestore()
  const snap = await db.collection('metrics').get()
  const rows: UserMetricsView[] = snap.docs.map((doc) => {
    const data = doc.data() as StoredMetrics
    return {
      uid: doc.id,
      email: data.email ?? '(unknown)',
      firstSeenAt: data.firstSeenAt?.toDate().toISOString() ?? null,
      lastSeenAt: data.lastSeenAt?.toDate().toISOString() ?? null,
      signIns: data.signIns ?? 0,
      plansOpened: data.plansOpened ?? 0,
      aiSuggestions: data.aiSuggestions ?? 0,
      slotCommits: data.slotCommits ?? 0,
      slotClears: data.slotClears ?? 0,
    }
  })
  rows.sort((a, b) => {
    if (a.lastSeenAt === b.lastSeenAt) return 0
    if (a.lastSeenAt === null) return 1
    if (b.lastSeenAt === null) return -1
    return a.lastSeenAt < b.lastSeenAt ? 1 : -1
  })
  return rows
}
