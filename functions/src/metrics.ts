import { FieldValue, Timestamp } from 'firebase-admin/firestore'

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
