import { isSongSlot } from '../songSlots'
import type { PlanItem } from '../api'

// Pure helpers for slot-state action paths. Both AI tool handling
// and UI flows (DnD, button clicks, popovers) depend on these — see
// docs/unification-plan.md and the Architecture philosophy section
// of CLAUDE.md. No I/O, no React state, no Cloud Function calls
// from this module.

/** Minimal candidate shape the helpers need. CandidateMatch in
 *  PlanDetail and PersistedCandidate in lib/api both satisfy this
 *  structurally, so callers don't need to convert. */
export interface CandidateState {
  id: string
  decision: 'pending' | 'reject'
  committedAt: number | null
  assignedSlotItemId: string | null
  priorSlotTitle: string | null
  suggestion: { title: string }
  /** Matched library song, when known. Used as a second signal for
   *  taint detection — the user may have committed a song whose
   *  PCO library title differs from the AI's proposed title. */
  song?: { title?: string | null } | null | undefined
}

/** Build the set of normalised song titles currently "known" to the
 *  SPA — every candidate's suggestion title + matched library
 *  song title + every PCO item's songTitle. Used as the haystack
 *  for taint detection: a `priorSlotTitle` matching anything in here
 *  is almost certainly a stale song name carried forward by an
 *  earlier commit/move/swap, not a real placeholder. True
 *  placeholders ("Song 1", "Closing song") won't appear in this
 *  set so they survive the check. */
export function buildKnownSongTitles(
  candidates: readonly CandidateState[],
  items: readonly PlanItem[] | null | undefined,
): Set<string> {
  const out = new Set<string>()
  for (const c of candidates) {
    const t = c.suggestion.title.trim().toLowerCase()
    if (t) out.add(t)
    const songTitle = c.song?.title?.trim().toLowerCase()
    if (songTitle) out.add(songTitle)
  }
  for (const it of items ?? []) {
    const st = it.songTitle?.trim().toLowerCase()
    if (st) out.add(st)
  }
  return out
}

/** True iff `title` (after trim/lowercase) appears in `knownSongTitles`.
 *  Empty / null / whitespace-only inputs are not tainted (the caller
 *  decides what to do with them — typically fall back). */
export function isTaintedTitle(
  title: string | null | undefined,
  knownSongTitles: Set<string>,
): boolean {
  const trimmed = title?.trim()
  if (!trimmed) return false
  return knownSongTitles.has(trimmed.toLowerCase())
}

/** Capture-time helper for `priorSlotTitle`. PCO rewrites a slot's
 *  `title` attribute to the song's name when a song is linked
 *  (the PCO web UI does it implicitly; we do it explicitly via
 *  PATCH on commit). So a slot whose `title` equals its `songTitle`
 *  isn't holding a true placeholder — it's holding the previous
 *  song's name. Capturing that as `priorSlotTitle` would taint the
 *  next clear's restore step. Falling back to the persisted
 *  placeholder (or to the position-based "Song N" via
 *  `fallbackForSlot`) is strictly better than carrying a stale
 *  song title.
 *
 *  Returns null when the slot has no title at all. */
export function placeholderForSlot(
  slotItem: PlanItem,
  slotPlaceholders: Readonly<Record<string, string>>,
  fallbackForSlot: (itemId: string) => string,
): string | null {
  const title = slotItem.title?.trim() ?? null
  if (!title) return null
  const songTitle = slotItem.songTitle?.trim()
  if (songTitle && songTitle.toLowerCase() === title.toLowerCase()) {
    return slotPlaceholders[slotItem.id] ?? fallbackForSlot(slotItem.id)
  }
  return title
}

/** Given a target slot we're about to commit into, find the
 *  currently-committed candidate sitting there (if any) so the
 *  caller can evict it. Excludes the candidate we're committing
 *  (so a no-op self-commit isn't flagged as eviction). */
export function findEvictionTarget<C extends CandidateState>(
  targetSlotItemId: string,
  candidates: readonly C[],
  excludeCandidateId: string,
): C | null {
  for (const c of candidates) {
    if (c.id === excludeCandidateId) continue
    if (c.assignedSlotItemId !== targetSlotItemId) continue
    if (c.committedAt == null) continue
    return c
  }
  return null
}

/** Inputs to the restore-title resolver. Each tier is optional so
 *  the same resolver covers commit-time and clear-time use sites:
 *  commit-time has an item but no candidate-prior; clear-time has
 *  both. */
export interface RestoreTitleInputs {
  slotItemId: string
  slotPlaceholders: Readonly<Record<string, string>>
  /** Title captured on the candidate at commit time. Filtered
   *  through taint detection before being used. */
  candidatePriorSlotTitle?: string | null
  /** Built via `buildKnownSongTitles`. Required only when
   *  `candidatePriorSlotTitle` is provided. */
  knownSongTitles?: Set<string>
  /** Position-based fallback ("Song N"). Always provided so the
   *  resolver can never return null. */
  fallbackForSlot: (itemId: string) => string
}

/** Pick the title to restore on a clear / move-source. Priority:
 *
 *    1. server-persisted slotPlaceholders[itemId] — the most
 *       trustworthy source; survives sessions and pre-songpicker
 *       PCO state changes.
 *    2. candidate's stored priorSlotTitle, if it's not tainted
 *       (matches a currently-known song title).
 *    3. position-based "Song N" via `fallbackForSlot`.
 *
 *  Always returns a non-empty string. */
export function resolveRestoreTitle(input: RestoreTitleInputs): string {
  const persisted = input.slotPlaceholders[input.slotItemId]?.trim()
  if (persisted) return persisted
  const prior = input.candidatePriorSlotTitle?.trim()
  if (prior && input.knownSongTitles) {
    if (!isTaintedTitle(prior, input.knownSongTitles)) return prior
  } else if (prior) {
    // No known-titles set provided → caller is opting out of taint
    // detection. Trust the prior as-is.
    return prior
  }
  return input.fallbackForSlot(input.slotItemId)
}

/** Position-based fallback "Song N" where N is the 1-based index of
 *  this item among song slots in the current items array. Pure —
 *  doesn't depend on React state. Returns "Song" if the item isn't
 *  found among song slots. */
export function fallbackSlotTitle(
  itemId: string,
  items: readonly PlanItem[] | null | undefined,
): string {
  const songSlotItems = (items ?? []).filter(isSongSlot)
  const idx = songSlotItems.findIndex((s) => s.id === itemId)
  return idx >= 0 ? `Song ${idx + 1}` : 'Song'
}

/** Pre-turn snapshot of slot placeholder identities. For each
 *  currently-committed candidate, captures the slot's original
 *  placeholder name (its `priorSlotTitle`), filtering out tainted
 *  values. Multi-assignment intents (AI swaps, future multi-DnD)
 *  feed each commit's `priorSlotTitle` from this map so swaps
 *  preserve placeholder identity even mid-turn. */
export function preTurnSlotPlaceholders(
  candidates: readonly CandidateState[],
  knownSongTitles: Set<string>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of candidates) {
    if (!c.committedAt) continue
    if (!c.assignedSlotItemId) continue
    const prior = c.priorSlotTitle?.trim()
    if (!prior) continue
    if (isTaintedTitle(prior, knownSongTitles)) continue
    out.set(c.assignedSlotItemId, prior)
  }
  return out
}

/** Detect swap pairs in an assignment list: assignment X is a swap
 *  partner of assignment Y if the candidate currently committed at
 *  X's target slot is the candidate Y wants to put in Y's target
 *  slot, and vice versa. Used both to elect a single PCO reorder
 *  instead of paired clears+commits, and to render a single
 *  "swapped" chat message instead of two commits.
 *
 *  Returns a Map<index, partnerIndex> covering both halves of each
 *  detected pair. Asymmetric or unpaired assignments are absent
 *  from the map. */
export interface AssignmentLike {
  slotItemId: string
  candidateId: string | null
}
export function detectSwapPairs(
  assignments: readonly AssignmentLike[],
  candidates: readonly CandidateState[],
): Map<number, number> {
  const partner = new Map<number, number>()
  // Index for fast "what's currently at slot X?" lookups.
  const committedAtSlot = new Map<string, string>()
  for (const c of candidates) {
    if (c.committedAt && c.assignedSlotItemId) {
      committedAtSlot.set(c.assignedSlotItemId, c.id)
    }
  }
  for (let i = 0; i < assignments.length; i++) {
    if (partner.has(i)) continue
    const ai = assignments[i]
    if (ai.candidateId == null) continue
    const aiCurrentSlotOfTargetCand = committedAtSlot.get(ai.slotItemId)
    if (!aiCurrentSlotOfTargetCand) continue
    for (let j = i + 1; j < assignments.length; j++) {
      if (partner.has(j)) continue
      const aj = assignments[j]
      if (aj.candidateId == null) continue
      const ajCurrentSlotOfTargetCand = committedAtSlot.get(aj.slotItemId)
      if (!ajCurrentSlotOfTargetCand) continue
      // i wants to put X in slot A; j wants to put Y in slot B.
      // It's a swap iff X currently lives in slot B AND Y currently
      // lives in slot A.
      const xLivesAtB =
        committedAtSlot.get(aj.slotItemId) === ai.candidateId
      const yLivesAtA =
        committedAtSlot.get(ai.slotItemId) === aj.candidateId
      if (xLivesAtB && yLivesAtA) {
        partner.set(i, j)
        partner.set(j, i)
        break
      }
    }
  }
  return partner
}
