import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { distillSingleReason, matchFreeformToChip } from './ai/distill'

// Global, app-wide list of "why was this rejected" reasons. Surfaced as
// one-tap chips next to the freeform textarea on a rejected candidate.
// Single doc keeps the read path cheap; one shared list across all users
// is intentional — Matt asked for it global.

export type CommonReasonSource = 'manual' | 'ai' | 'seed'

export interface CommonReason {
  text: string
  addedAt: number
  source: CommonReasonSource
  /** How many times this chip has been used as a rejection reason —
   *  via direct chip tap, exact-text freeform, or AI-semantic match.
   *  Older docs without this field default to 0 on read. */
  useCount: number
}

export interface RejectionReasonsDoc {
  common: CommonReason[]
  seeded: boolean
}

// Sensible starter chips so the rationale UI is useful on day one.
// Re-seeding never runs once `seeded: true` is set, so a user who
// removes all of these gets the empty state they asked for.
const SEED_REASONS: string[] = [
  'Too slow',
  'Too upbeat',
  'Played recently',
  'Doesn\'t fit theme',
  'Hard to sing',
]

// Cap on the AI-distilled chip pool. The user-facing picker shows the
// top MAX_USER_AI_CHIPS (3, in lib/chipRanking.ts on the SPA side); the
// remaining 20 slots are "proto" chips visible only in the admin UI.
// When a fresh chip would push the pool past this size, we evict the
// lowest-ranked AI chip (least used, oldest tiebreaker) so the pool
// stays fresh instead of accumulating zombies.
const MAX_AI_CHIPS = 23

const DOC_PATH = 'appConfig/rejectionReasons'

function emptyDoc(): RejectionReasonsDoc {
  return {
    common: [],
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
    seeded: d.seeded === true,
    // Old fields (recentFreeform, freeformSinceDistill, lastDistilledAt)
    // are silently ignored — the new model has no batched-distillation
    // counter or freeform log. Existing docs migrate on the next write.
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
    useCount:
      typeof r.useCount === 'number' && Number.isFinite(r.useCount) && r.useCount > 0
        ? Math.floor(r.useCount)
        : 0,
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

// Trims the AI-distilled chip pool to MAX_AI_CHIPS by ranking AI chips
// by useCount desc + addedAt desc and dropping the tail. Seed and
// manual chips are admin-curated and never auto-evicted.
function enforceAiPoolCap(reasons: CommonReason[]): CommonReason[] {
  const ai = reasons.filter((c) => c.source === 'ai')
  if (ai.length <= MAX_AI_CHIPS) return reasons
  const ranked = [...ai].sort(
    (a, b) => b.useCount - a.useCount || b.addedAt - a.addedAt,
  )
  const keep = new Set(ranked.slice(0, MAX_AI_CHIPS).map((c) => c.text))
  return reasons.filter((c) => c.source !== 'ai' || keep.has(c.text))
}

export async function listRejectionReasons(): Promise<RejectionReasonsDoc> {
  const doc = await loadDoc()
  if (doc.seeded) return doc
  // First read ever — seed defaults, mark as seeded so removals stick.
  const now = Date.now()
  const seeded: RejectionReasonsDoc = {
    ...doc,
    common: SEED_REASONS.map((text) => ({
      text,
      addedAt: now,
      source: 'seed',
      useCount: 0,
    })),
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

export interface RenameResult {
  doc: RejectionReasonsDoc
  /** Set when newText would collide with another existing chip. The
   *  caller surfaces this to the admin UI as an inline error. */
  collisionWith?: string
}

// Rename an existing chip. Preserves useCount/addedAt/source. Rejects
// if the new text would collide with a *different* existing chip (via
// norm()-equivalent comparison) — that case requires the admin to
// delete one or the other first to avoid silently merging counts.
export async function renameCommonReason(
  oldText: string,
  newText: string,
): Promise<RenameResult> {
  const trimmedNew = newText.trim()
  if (!trimmedNew) {
    throw new Error('new text must be non-empty')
  }
  const oldKey = norm(oldText)
  const newKey = norm(trimmedNew)
  const doc = await loadDoc()
  const existing = doc.common.find((c) => norm(c.text) === oldKey)
  if (!existing) {
    // Nothing to rename. Treat as a no-op rather than an error so a
    // racing admin page double-click doesn't blow up.
    return { doc }
  }
  // Collision check: only flag when the new key matches a DIFFERENT
  // chip's normalized text. Case/punctuation-only edits of the same
  // chip are allowed.
  if (newKey !== oldKey) {
    const collide = doc.common.find(
      (c) => c !== existing && norm(c.text) === newKey,
    )
    if (collide) return { doc, collisionWith: collide.text }
  }
  const next = doc.common.map((c) =>
    c === existing ? { ...c, text: trimmedNew } : c,
  )
  await getFirestore()
    .doc(DOC_PATH)
    .set({ common: next, seeded: true }, { merge: true })
  return { doc: { ...doc, common: next } }
}

export interface RecordRejectReasonResult {
  doc: RejectionReasonsDoc
  /** The canonical chip text the freeform reason was matched to (via
   *  exact `norm()`, AI-semantic match, or a fresh distillation that
   *  added a new chip). When set, the SPA should overwrite its local
   *  rejectReason with this value so future AI turns see consistent
   *  per-candidate metadata. */
  matchedChipText: string | null
}

// Record a reject reason. Three-tier resolution:
//   1. norm() exact match against existing chips → bump useCount,
//      return matchedChipText. No AI call.
//   2. AI semantic match against existing chips → bump useCount,
//      return matchedChipText. One cheap Haiku call.
//   3. Tier-3 (genuinely novel): ask Haiku to distill the freeform
//      text into a short chip label, add it to the pool with
//      useCount=1, return matchedChipText. The user-facing picker
//      decides which proto chips to surface (via lib/chipRanking).
// Tiers 1 and 2 don't grow the pool; Tier 3 is the only path that
// adds chips, and the pool is bounded by MAX_AI_CHIPS via
// enforceAiPoolCap after every Tier-3 write.
export async function recordRejectReason(
  reason: string,
  apiKey: string | null,
): Promise<RecordRejectReasonResult> {
  const text = reason.trim()
  if (!text) {
    const doc = await listRejectionReasons()
    return { doc, matchedChipText: null }
  }

  const ref = getFirestore().doc(DOC_PATH)
  const before = await loadDoc()
  const seededCommon = before.seeded
    ? before.common
    : SEED_REASONS.map((t) => ({
        text: t,
        addedAt: Date.now(),
        source: 'seed' as const,
        useCount: 0,
      }))

  // Tier 1: norm() exact match — cheap path, no AI call. Catches the
  // chip-tap case (text matches a chip exactly) and trivial freeform
  // variants like "too slow." vs "Too slow".
  const key = norm(text)
  const exactHit = seededCommon.find((c) => norm(c.text) === key)
  if (exactHit) {
    const bumped = seededCommon.map((c) =>
      c === exactHit ? { ...c, useCount: c.useCount + 1 } : c,
    )
    const writeOut: RejectionReasonsDoc = { common: bumped, seeded: true }
    await ref.set(writeOut, { merge: true })
    return { doc: writeOut, matchedChipText: exactHit.text }
  }

  // Tier 2: AI semantic match. Best-effort — if the call fails or the
  // secret isn't wired, fall through to Tier 3 / fallback path.
  if (apiKey) {
    try {
      const matched = await matchFreeformToChip({
        apiKey,
        text,
        existingCommon: seededCommon.map((c) => c.text),
      })
      if (matched) {
        const hit = seededCommon.find((c) => c.text === matched)
        if (hit) {
          const bumped = seededCommon.map((c) =>
            c === hit ? { ...c, useCount: c.useCount + 1 } : c,
          )
          const writeOut: RejectionReasonsDoc = { common: bumped, seeded: true }
          await ref.set(writeOut, { merge: true })
          return { doc: writeOut, matchedChipText: hit.text }
        }
      }
    } catch (e) {
      console.warn('[songpicker] freeform→chip match failed:', e)
    }
  }

  // Tier 3: novel reason. Distill it into a short chip label and add
  // to the pool with useCount=1. If distillation returns null (rare —
  // garbled input the AI can't compress), fall back to the no-op
  // behavior of just returning the current doc without adding a chip.
  let distilled: string | null = null
  if (apiKey) {
    try {
      distilled = await distillSingleReason({
        apiKey,
        text,
        existingCommon: seededCommon.map((c) => c.text),
      })
    } catch (e) {
      console.warn('[songpicker] single-reason distillation failed:', e)
    }
  }

  if (!distilled) {
    // No chip produced — leave the pool alone. The local SPA reason
    // is the user's freeform text; matchedChipText stays null so the
    // SPA preserves the raw wording.
    const writeOut: RejectionReasonsDoc = { common: seededCommon, seeded: true }
    await ref.set(writeOut, { merge: true })
    return { doc: writeOut, matchedChipText: null }
  }

  // Race-protection: if distillation happened to produce a label that
  // norm-matches an existing chip (shouldn't, since Tier 2 already
  // checked, but the AI is fuzzy), prefer bumping the existing chip
  // over creating a duplicate.
  const distilledKey = norm(distilled)
  const dupe = seededCommon.find((c) => norm(c.text) === distilledKey)
  if (dupe) {
    const bumped = seededCommon.map((c) =>
      c === dupe ? { ...c, useCount: c.useCount + 1 } : c,
    )
    const writeOut: RejectionReasonsDoc = { common: bumped, seeded: true }
    await ref.set(writeOut, { merge: true })
    return { doc: writeOut, matchedChipText: dupe.text }
  }

  const newChip: CommonReason = {
    text: distilled,
    addedAt: Date.now(),
    source: 'ai',
    useCount: 1,
  }
  const capped = enforceAiPoolCap([...seededCommon, newChip])
  const writeOut: RejectionReasonsDoc = { common: capped, seeded: true }
  await ref.set(writeOut, { merge: true })
  return { doc: writeOut, matchedChipText: distilled }
}

// Helper used by callers that just need the public-facing shape
// without exposing internals.
export function publicShape(doc: RejectionReasonsDoc): {
  common: CommonReason[]
} {
  return { common: doc.common }
}

// FieldValue is re-exported so callable handlers don't need to import
// it separately when they want atomic increments etc. Not used yet,
// kept for future call sites.
export { FieldValue }
