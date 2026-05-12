import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { distillRejectionReasons } from './ai/distill'

// Global, app-wide list of "why was this rejected" reasons. Surfaced as
// one-tap chips next to the freeform textarea on a rejected candidate.
// Single doc keeps the read path cheap; one shared list across all users
// is intentional — Matt asked for it global.

export type CommonReasonSource = 'manual' | 'ai' | 'seed'

export interface CommonReason {
  text: string
  addedAt: number
  source: CommonReasonSource
}

export interface FreeformLogEntry {
  text: string
  at: number
}

export interface RejectionReasonsDoc {
  common: CommonReason[]
  recentFreeform: FreeformLogEntry[]
  lastDistilledAt: number
  freeformSinceDistill: number
  seeded: boolean
}

// Sensible starter chips so the rationale UI is useful on day one.
// Re-seeding never runs once `seeded: true` is set, so a user who
// removes all of these gets the empty state they asked for.
const SEED_REASONS: string[] = [
  'Too slow',
  'Too upbeat',
  'Already played recently',
  'Doesn\'t fit the theme',
  'Hard for the congregation to sing',
]

// How many freeform reasons must accumulate before we ask the AI to
// distill new chip-worthy categories. Low enough that the chip list
// stays fresh; high enough that we're not burning API calls on noise.
const DISTILL_THRESHOLD = 8

// Cap on the freeform log so the Firestore doc doesn't grow without
// bound. Oldest entries fall off the front when we append past the
// cap. Plenty of context for distillation while staying tiny.
const FREEFORM_LOG_CAP = 100

const DOC_PATH = 'appConfig/rejectionReasons'

function emptyDoc(): RejectionReasonsDoc {
  return {
    common: [],
    recentFreeform: [],
    lastDistilledAt: 0,
    freeformSinceDistill: 0,
    seeded: false,
  }
}

function sanitize(raw: unknown): RejectionReasonsDoc {
  if (!raw || typeof raw !== 'object') return emptyDoc()
  const d = raw as Record<string, unknown>
  return {
    common: Array.isArray(d.common)
      ? d.common
          .map(sanitizeCommon)
          .filter((c): c is CommonReason => !!c)
      : [],
    recentFreeform: Array.isArray(d.recentFreeform)
      ? d.recentFreeform
          .map(sanitizeFreeform)
          .filter((f): f is FreeformLogEntry => !!f)
      : [],
    lastDistilledAt:
      typeof d.lastDistilledAt === 'number' ? d.lastDistilledAt : 0,
    freeformSinceDistill:
      typeof d.freeformSinceDistill === 'number' ? d.freeformSinceDistill : 0,
    seeded: d.seeded === true,
  }
}

function sanitizeCommon(raw: unknown): CommonReason | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.text !== 'string' || !r.text.trim()) return null
  const source =
    r.source === 'manual' || r.source === 'ai' || r.source === 'seed'
      ? r.source
      : 'manual'
  return {
    text: r.text.trim(),
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : Date.now(),
    source,
  }
}

function sanitizeFreeform(raw: unknown): FreeformLogEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.text !== 'string' || !r.text.trim()) return null
  return {
    text: r.text.trim(),
    at: typeof r.at === 'number' ? r.at : Date.now(),
  }
}

async function loadDoc(): Promise<RejectionReasonsDoc> {
  const snap = await getFirestore().doc(DOC_PATH).get()
  if (!snap.exists) return emptyDoc()
  return sanitize(snap.data())
}

// Lower-cased exact-match lookup so we don't add duplicates that differ
// only by punctuation/whitespace from the AI's distillation output.
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[.!?,;:]+$/g, '')
}

function dedupeByText(reasons: CommonReason[]): CommonReason[] {
  const seen = new Set<string>()
  const out: CommonReason[] = []
  for (const r of reasons) {
    const key = norm(r.text)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

export async function listRejectionReasons(): Promise<RejectionReasonsDoc> {
  const doc = await loadDoc()
  if (doc.seeded) return doc
  // First read ever — seed defaults, mark as seeded so removals stick.
  const now = Date.now()
  const seeded: RejectionReasonsDoc = {
    ...doc,
    common: SEED_REASONS.map((text) => ({ text, addedAt: now, source: 'seed' })),
    seeded: true,
  }
  await getFirestore().doc(DOC_PATH).set(seeded, { merge: true })
  return seeded
}

export async function removeCommonReason(text: string): Promise<void> {
  const target = norm(text)
  const doc = await loadDoc()
  const next = doc.common.filter((c) => norm(c.text) !== target)
  if (next.length === doc.common.length) return
  await getFirestore()
    .doc(DOC_PATH)
    .set({ common: next, seeded: true }, { merge: true })
}

// Record a freeform reject reason in the global log and, if we've
// accumulated enough since the last distillation, ask the AI to turn
// the recent log into a few new chip-worthy categories. The
// distillation runs inline (which adds latency to *this* call only)
// so the user sees the new chips on their next page interaction.
export async function recordRejectReason(
  reason: string,
  apiKey: string | null,
): Promise<RejectionReasonsDoc> {
  const text = reason.trim()
  if (!text) return await listRejectionReasons()

  const ref = getFirestore().doc(DOC_PATH)
  const before = await loadDoc()
  const seededCommon = before.seeded
    ? before.common
    : SEED_REASONS.map((t) => ({ text: t, addedAt: Date.now(), source: 'seed' as const }))

  const newEntry: FreeformLogEntry = { text, at: Date.now() }
  // FIFO append, capped at FREEFORM_LOG_CAP entries.
  const trimmedLog = [...before.recentFreeform, newEntry].slice(-FREEFORM_LOG_CAP)
  const nextCount = before.freeformSinceDistill + 1

  let common = seededCommon
  let lastDistilledAt = before.lastDistilledAt
  let freeformSinceDistill = nextCount

  if (nextCount >= DISTILL_THRESHOLD && apiKey) {
    try {
      const newOnes = await distillRejectionReasons({
        apiKey,
        existingCommon: common.map((c) => c.text),
        recentFreeform: trimmedLog.map((f) => f.text),
      })
      if (newOnes.length > 0) {
        const now = Date.now()
        const additions: CommonReason[] = newOnes.map((t) => ({
          text: t,
          addedAt: now,
          source: 'ai',
        }))
        common = dedupeByText([...common, ...additions])
      }
      lastDistilledAt = Date.now()
      freeformSinceDistill = 0
    } catch (e) {
      // Distillation is best-effort. Don't fail the reason save just
      // because the AI call hiccupped — leave the counter alone so
      // we retry on the next call past threshold.
      console.warn('[songpicker] rejection-reason distillation failed:', e)
    }
  }

  const writeOut: RejectionReasonsDoc = {
    common,
    recentFreeform: trimmedLog,
    lastDistilledAt,
    freeformSinceDistill,
    seeded: true,
  }
  await ref.set(writeOut, { merge: true })
  return writeOut
}

// Helper used by callers that just need the public-facing shape (chips
// + freeform log size) without exposing internals.
export function publicShape(doc: RejectionReasonsDoc): {
  common: CommonReason[]
  freeformSinceDistill: number
  lastDistilledAt: number
} {
  return {
    common: doc.common,
    freeformSinceDistill: doc.freeformSinceDistill,
    lastDistilledAt: doc.lastDistilledAt,
  }
}

// FieldValue is re-exported so callable handlers don't need to import
// it separately when they want atomic increments etc. Not used yet,
// kept for future call sites.
export { FieldValue }
