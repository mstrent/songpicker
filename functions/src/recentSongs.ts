import { getFirestore } from 'firebase-admin/firestore'

import { normalizeText } from './normalize'
import { pMap } from './pco/concurrency'
import type { PcoClient } from './pco/client'

/** A song this congregation has already sung, with the date of the
 *  most recent service that used it. */
export interface RecentSong {
  title: string
  author: string | null
  /** ISO date (`sort_date`) of the most recent plan that used it. */
  lastSungAt: string
}

// The rotation rule, in days: repeating inside two weeks is a hard
// no; inside six weeks it should weigh against a song without ruling
// it out. Anything older carries no restriction at all, so it is
// dropped from the payload entirely rather than spending tokens
// telling the model a song is fine.
export const HARD_BLOCK_DAYS = 14
export const REDUCED_WEIGHT_DAYS = 42

// How many past plans to pull before filtering by date. A Sunday-only
// service type runs ~6 plans in the reduced-weight window; 10 leaves
// room for midweek extras and holiday services without a second page.
const PAST_PLANS_TO_SCAN = 10

// Past plans change once a week at most, so this can be stale for
// hours without consequence. Six hours keeps a planning session on one
// fetch while still picking up a newly-finalised service the same day.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

const COLLECTION = 'recentSongs'

const docRef = (uid: string, serviceTypeId: string) =>
  getFirestore().doc(`${COLLECTION}/${uid}/serviceTypes/${serviceTypeId}`)

function daysBetween(fromIso: string, now: Date): number {
  const then = new Date(fromIso).getTime()
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY
  return Math.floor((now.getTime() - then) / 86_400_000)
}

export interface RecentSongBuckets {
  /** Sung inside HARD_BLOCK_DAYS — off the table. */
  blocked: RecentSong[]
  /** Sung between HARD_BLOCK_DAYS and REDUCED_WEIGHT_DAYS — allowed,
   *  but needs to clearly beat a fresher option. */
  reduced: RecentSong[]
}

/** Split into the two recency bands, dropping anything older than the
 *  reduced-weight window. A song sung more than once lands in the band
 *  for its MOST RECENT outing — singing something last week and also
 *  four months ago makes it blocked, not fine. Pure: `now` is injected
 *  so the bands are testable without freezing the clock. */
export function bucketRecentSongs(
  songs: readonly RecentSong[],
  now: Date,
): RecentSongBuckets {
  const mostRecent = new Map<string, RecentSong>()
  for (const s of songs) {
    const key = `${normalizeText(s.title)}|${normalizeText(s.author ?? '')}`
    const existing = mostRecent.get(key)
    if (!existing || s.lastSungAt > existing.lastSungAt) {
      mostRecent.set(key, s)
    }
  }

  const blocked: RecentSong[] = []
  const reduced: RecentSong[] = []
  for (const s of mostRecent.values()) {
    const age = daysBetween(s.lastSungAt, now)
    if (age <= HARD_BLOCK_DAYS) blocked.push(s)
    else if (age <= REDUCED_WEIGHT_DAYS) reduced.push(s)
  }
  const byRecency = (a: RecentSong, b: RecentSong) =>
    b.lastSungAt.localeCompare(a.lastSungAt)
  blocked.sort(byRecency)
  reduced.sort(byRecency)
  return { blocked, reduced }
}

function renderSong(s: RecentSong): string {
  return s.author ? `${s.title} (${s.author})` : s.title
}

/** Render the block the model sees. The thresholds are baked into the
 *  labels rather than restated in the system prompt — the data says
 *  what to do with each band, so the prompt only has to point here.
 *  Returns '' when there is nothing to say, so the caller can omit the
 *  section entirely rather than emitting an empty header. */
export function formatRecentlySung(
  songs: readonly RecentSong[],
  now: Date,
): string {
  const { blocked, reduced } = bucketRecentSongs(songs, now)
  if (blocked.length === 0 && reduced.length === 0) return ''

  const lines = ['Recently sung by this congregation:']
  if (blocked.length > 0) {
    lines.push(
      `  Within the last two weeks — do NOT propose these: ${blocked.map(renderSong).join(', ')}`,
    )
  }
  if (reduced.length > 0) {
    lines.push(
      `  Two to six weeks ago — propose only if clearly the best fit for the theme: ${reduced.map(renderSong).join(', ')}`,
    )
  }
  return lines.join('\n')
}

interface CacheDoc {
  songs: RecentSong[]
  fetchedAt: number
}

/** Collect the songs used in this service type's recent past plans.
 *  Cached per user + service type because it costs ~13 PCO calls and
 *  changes weekly at most. Deliberately not folded into
 *  getPlanContext — that would spend those calls on every plan open.
 *  Failures are swallowed: rotation context is an enhancement, and a
 *  PCO hiccup here should degrade the suggestion rather than break it. */
export async function loadRecentSongs(
  uid: string,
  pco: PcoClient,
  serviceTypeId: string,
  now: Date = new Date(),
): Promise<RecentSong[]> {
  const ref = docRef(uid, serviceTypeId)
  try {
    const snap = await ref.get()
    const cached = snap.exists ? (snap.data() as CacheDoc) : null
    if (cached && now.getTime() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.songs
    }
  } catch {
    // Fall through to a live fetch; a cache read failure shouldn't
    // cost the caller its rotation context.
  }

  let songs: RecentSong[]
  try {
    // `name` only feeds serviceTypeName on the returned plans, which
    // this path never reads — no need to spend a listServiceTypes call
    // resolving it.
    const plans = await pco.listPlans(
      { id: serviceTypeId, name: null },
      { filter: 'past', perPage: PAST_PLANS_TO_SCAN, order: '-sort_date' },
    )
    // Only fetch items for plans that could land in either band. Older
    // plans carry no restriction, so their items are wasted calls.
    const inWindow = plans.filter(
      (p) => p.sortDate && daysBetween(p.sortDate, now) <= REDUCED_WEIGHT_DAYS,
    )
    const perPlan = await pMap(
      inWindow,
      async (p) => {
        const items = await pco.listPlanItems(serviceTypeId, p.id)
        return items
          .filter((it) => it.songId && it.songTitle)
          .map(
            (it): RecentSong => ({
              title: it.songTitle!,
              author: it.songAuthor,
              lastSungAt: p.sortDate!,
            }),
          )
      },
      4,
    )
    songs = perPlan.flat()
  } catch (err) {
    console.warn('[recentSongs] fetch failed; continuing without it:', err)
    return []
  }

  ref
    .set({ songs, fetchedAt: now.getTime() } satisfies CacheDoc)
    .catch(() => {})
  return songs
}
