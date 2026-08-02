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

/** How long a song stays off the table after being sung, and how long
 *  it stays disfavoured after that. Admin-tunable — worship rotations
 *  differ, and these two numbers are exactly the kind of thing that
 *  wants a dial rather than a deploy. */
export interface RotationWindows {
  /** Sung within this many days: do not propose at all. */
  hardBlockDays: number
  /** Sung within this many days (but past hardBlockDays): allowed, but
   *  needs to clearly beat a fresher option. */
  reducedWeightDays: number
  /** Already scheduled within this many days ahead: allowed, but
   *  weighs against the song — putting it in this service too would
   *  create a repeat. Always a soft bias, never a block: future plans
   *  are provisional and get rearranged. */
  lookAheadDays: number
}

export const DEFAULT_ROTATION_WINDOWS: RotationWindows = {
  hardBlockDays: 14,
  reducedWeightDays: 42,
  lookAheadDays: 60,
}

// Upper bound on the configurable window. Past this the block starts
// costing real prompt tokens for songs nobody was going to repeat
// anyway, and the PCO scan gets expensive.
export const MAX_REDUCED_WEIGHT_DAYS = 120
export const MAX_LOOK_AHEAD_DAYS = 120

// Plans are fetched to cover the configured window, plus margin for
// midweek and holiday services that share a service type.
const PLAN_SCAN_MARGIN = 4
const MAX_PLANS_TO_SCAN = 40

// Past plans change once a week at most, so this can be stale for
// hours without consequence. Six hours keeps a planning session on one
// fetch while still picking up a newly-finalised service the same day.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

const COLLECTION = 'recentSongs'
const ADMIN_DOC = 'appConfig/global'

const docRef = (uid: string, serviceTypeId: string) =>
  getFirestore().doc(`${COLLECTION}/${uid}/serviceTypes/${serviceTypeId}`)

/** Validate stored or user-supplied windows. Pure, and returns null
 *  rather than throwing so the read path can fall back to defaults
 *  while the write path can turn null into a clear error. */
export function parseRotationWindows(raw: unknown): RotationWindows | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const hard = r.hardBlockDays
  const reduced = r.reducedWeightDays
  // Absent lookAheadDays reads as the default rather than a rejection:
  // configs written before the look-ahead existed are still valid.
  const ahead = r.lookAheadDays ?? DEFAULT_ROTATION_WINDOWS.lookAheadDays
  if (
    typeof hard !== 'number' ||
    typeof reduced !== 'number' ||
    typeof ahead !== 'number'
  ) {
    return null
  }
  if (
    !Number.isInteger(hard) ||
    !Number.isInteger(reduced) ||
    !Number.isInteger(ahead)
  ) {
    return null
  }
  if (hard < 1) return null
  // Equal windows would render an empty reduced band and read as a
  // configuration mistake; require the bands to be distinct.
  if (reduced <= hard) return null
  if (reduced > MAX_REDUCED_WEIGHT_DAYS) return null
  // Zero is meaningful here — it turns the look-ahead off entirely.
  if (ahead < 0 || ahead > MAX_LOOK_AHEAD_DAYS) return null
  return {
    hardBlockDays: hard,
    reducedWeightDays: reduced,
    lookAheadDays: ahead,
  }
}

/** Admin-configured windows, falling back to the defaults when unset
 *  or unparseable. Stored alongside the admin prompt overrides in
 *  appConfig/global. */
export async function loadRotationWindows(): Promise<RotationWindows> {
  try {
    const snap = await getFirestore().doc(ADMIN_DOC).get()
    const raw = snap.exists
      ? (snap.data() as { rotation?: unknown }).rotation
      : null
    return parseRotationWindows(raw) ?? DEFAULT_ROTATION_WINDOWS
  } catch {
    return DEFAULT_ROTATION_WINDOWS
  }
}

export async function saveRotationWindows(w: RotationWindows): Promise<void> {
  await getFirestore().doc(ADMIN_DOC).set({ rotation: w }, { merge: true })
}

function daysBetween(fromIso: string, now: Date): number {
  const then = new Date(fromIso).getTime()
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY
  return Math.floor((now.getTime() - then) / 86_400_000)
}

export interface RecentSongBuckets {
  /** Sung inside hardBlockDays — off the table. */
  blocked: RecentSong[]
  /** Sung between hardBlockDays and reducedWeightDays — allowed, but
   *  needs to clearly beat a fresher option. */
  reduced: RecentSong[]
}

/** Split into the two recency bands, dropping anything older than the
 *  reduced-weight window. A song sung more than once lands in the band
 *  for its MOST RECENT outing — singing something last week and also
 *  four months ago makes it blocked, not fine. Pure: `now` and the
 *  windows are injected so the bands are testable without freezing the
 *  clock or reaching for Firestore. */
export function bucketRecentSongs(
  songs: readonly RecentSong[],
  now: Date,
  windows: RotationWindows = DEFAULT_ROTATION_WINDOWS,
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
    if (age <= windows.hardBlockDays) blocked.push(s)
    else if (age <= windows.reducedWeightDays) reduced.push(s)
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
 *  what to do with each band, so the prompt only has to point here,
 *  and retuning the windows can't leave the prompt describing the old
 *  ones. Labels are in days rather than prose ("two weeks") precisely
 *  because the windows are configurable: a generated phrase would
 *  drift from the number it describes.
 *  Returns '' when there is nothing to say, so the caller can omit the
 *  section entirely rather than emitting an empty header. */
export function formatRecentlySung(
  songs: readonly RecentSong[],
  now: Date,
  windows: RotationWindows = DEFAULT_ROTATION_WINDOWS,
): string {
  const { blocked, reduced } = bucketRecentSongs(songs, now, windows)
  if (blocked.length === 0 && reduced.length === 0) return ''

  const lines = ['Recently sung by this congregation:']
  if (blocked.length > 0) {
    lines.push(
      `  Sung within the last ${windows.hardBlockDays} days — do NOT propose these: ${blocked.map(renderSong).join(', ')}`,
    )
  }
  if (reduced.length > 0) {
    lines.push(
      `  Sung ${windows.hardBlockDays + 1}-${windows.reducedWeightDays} days ago — propose only if clearly the best fit for the theme: ${reduced.map(renderSong).join(', ')}`,
    )
  }
  return lines.join('\n')
}

/** A song already scheduled in an upcoming service. */
export interface UpcomingSong {
  title: string
  author: string | null
  /** ISO date of the service it's scheduled for. */
  scheduledFor: string
  /** The plan it's scheduled in, so the plan currently being edited
   *  can be filtered out — its songs are already covered by
   *  "Already in plan" and aren't a future conflict with themselves. */
  planId: string
}

/** Render the look-ahead block. Always a soft bias — future plans get
 *  rearranged, so a hard block on a provisional booking would be
 *  wrong. Grouped by service date because proximity matters: a song
 *  booked for next week conflicts far more than one booked in seven.
 *  Returns '' when there's nothing to say. */
export function formatScheduledAhead(
  songs: readonly UpcomingSong[],
  excludePlanId: string | undefined,
  now: Date,
  windows: RotationWindows = DEFAULT_ROTATION_WINDOWS,
): string {
  if (windows.lookAheadDays <= 0) return ''
  const byDate = new Map<string, UpcomingSong[]>()
  for (const s of songs) {
    if (excludePlanId && s.planId === excludePlanId) continue
    const daysAway = -daysBetween(s.scheduledFor, now)
    if (daysAway < 0 || daysAway > windows.lookAheadDays) continue
    const key = s.scheduledFor.slice(0, 10)
    const bucket = byDate.get(key)
    if (bucket) bucket.push(s)
    else byDate.set(key, [s])
  }
  if (byDate.size === 0) return ''

  const lines = [
    `Already scheduled in the next ${windows.lookAheadDays} days — proposing one here would repeat it within weeks, so it needs to clearly beat an unscheduled option:`,
  ]
  for (const date of [...byDate.keys()].sort()) {
    const songsForDate = byDate
      .get(date)!
      .map((s) => (s.author ? `${s.title} (${s.author})` : s.title))
      .join(', ')
    lines.push(`  ${date}: ${songsForDate}`)
  }
  return lines.join('\n')
}

interface UpcomingCacheDoc {
  songs: UpcomingSong[]
  fetchedAt: number
  scannedDays: number
}

// Future plans are provisional and get edited — including by this app,
// when the user commits a song to an adjacent week. A short TTL keeps
// the look-ahead honest without refetching on every turn.
const UPCOMING_CACHE_TTL_MS = 15 * 60 * 1000

const upcomingRef = (uid: string, serviceTypeId: string) =>
  getFirestore().doc(`${COLLECTION}/${uid}/upcoming/${serviceTypeId}`)

/** Songs already booked into upcoming services for this service type.
 *  The whole future window is cached regardless of which plan is being
 *  edited; the current plan is filtered out at render time so the
 *  cache key stays per-service-type. Same swallow-and-degrade posture
 *  as loadRecentSongs. */
export async function loadUpcomingSongs(
  uid: string,
  pco: PcoClient,
  serviceTypeId: string,
  windows: RotationWindows = DEFAULT_ROTATION_WINDOWS,
  now: Date = new Date(),
): Promise<UpcomingSong[]> {
  if (windows.lookAheadDays <= 0) return []
  const startedAt = Date.now()
  const ref = upcomingRef(uid, serviceTypeId)
  try {
    const snap = await ref.get()
    const cached = snap.exists ? (snap.data() as UpcomingCacheDoc) : null
    if (
      cached &&
      now.getTime() - cached.fetchedAt < UPCOMING_CACHE_TTL_MS &&
      (cached.scannedDays ?? 0) >= windows.lookAheadDays
    ) {
      const ageMin = Math.round((now.getTime() - cached.fetchedAt) / 60_000)
      console.log(
        `[upcomingSongs] cache hit: ${cached.songs.length} entries, scanned ${cached.scannedDays}d, ${ageMin}min old`,
      )
      return cached.songs
    }
  } catch {
    // Degrade to a live fetch.
  }

  const perPage = Math.min(
    MAX_PLANS_TO_SCAN,
    Math.ceil(windows.lookAheadDays / 7) + PLAN_SCAN_MARGIN,
  )

  let songs: UpcomingSong[]
  try {
    const plans = await pco.listPlans(
      { id: serviceTypeId, name: null },
      { filter: 'future', perPage, order: 'sort_date' },
    )
    const inWindow = plans.filter(
      (p) => p.sortDate && -daysBetween(p.sortDate, now) <= windows.lookAheadDays,
    )
    const perPlan = await pMap(
      inWindow,
      async (p) => {
        const items = await pco.listPlanItems(serviceTypeId, p.id)
        return items
          .filter((it) => it.songId && it.songTitle)
          .map(
            (it): UpcomingSong => ({
              title: it.songTitle!,
              author: it.songAuthor,
              scheduledFor: p.sortDate!,
              planId: p.id,
            }),
          )
      },
      4,
    )
    songs = perPlan.flat()
    const perService = inWindow
      .map((p, i) => `${p.sortDate?.slice(0, 10)}(${perPlan[i].length})`)
      .join(', ')
    console.log(
      `[upcomingSongs] fetched in ${Date.now() - startedAt}ms: ${plans.length} plans listed, ${inWindow.length} in window (${windows.lookAheadDays}d), ${songs.length} song slots`,
    )
    if (perService) console.log(`[upcomingSongs] services: ${perService}`)
  } catch (err) {
    console.warn('[upcomingSongs] fetch failed; continuing without it:', err)
    return []
  }

  ref
    .set({
      songs,
      fetchedAt: now.getTime(),
      scannedDays: windows.lookAheadDays,
    } satisfies UpcomingCacheDoc)
    .catch(() => {})
  return songs
}

interface CacheDoc {
  songs: RecentSong[]
  fetchedAt: number
  /** The reduced-weight window this snapshot was scanned for. A cache
   *  written for a narrower window can't answer a wider one, so
   *  widening the admin setting has to force a refetch rather than
   *  silently returning a short list. */
  scannedDays: number
}

/** Collect the songs used in this service type's recent past plans.
 *  Cached per user + service type because it costs a PCO call per plan
 *  in the window and changes weekly at most. Deliberately not folded
 *  into getPlanContext — that would spend those calls on every plan
 *  open. Failures are swallowed: rotation context is an enhancement,
 *  and a PCO hiccup here should degrade the suggestion rather than
 *  break it. */
export async function loadRecentSongs(
  uid: string,
  pco: PcoClient,
  serviceTypeId: string,
  windows: RotationWindows = DEFAULT_ROTATION_WINDOWS,
  now: Date = new Date(),
): Promise<RecentSong[]> {
  const startedAt = Date.now()
  const ref = docRef(uid, serviceTypeId)
  try {
    const snap = await ref.get()
    const cached = snap.exists ? (snap.data() as CacheDoc) : null
    if (
      cached &&
      now.getTime() - cached.fetchedAt < CACHE_TTL_MS &&
      (cached.scannedDays ?? 0) >= windows.reducedWeightDays
    ) {
      const ageMin = Math.round((now.getTime() - cached.fetchedAt) / 60_000)
      console.log(
        `[recentSongs] cache hit: ${cached.songs.length} entries, scanned ${cached.scannedDays}d, ${ageMin}min old`,
      )
      return cached.songs
    }
  } catch {
    // Fall through to a live fetch; a cache read failure shouldn't
    // cost the caller its rotation context.
  }

  const perPage = Math.min(
    MAX_PLANS_TO_SCAN,
    Math.ceil(windows.reducedWeightDays / 7) + PLAN_SCAN_MARGIN,
  )

  let songs: RecentSong[]
  try {
    // `name` only feeds serviceTypeName on the returned plans, which
    // this path never reads — no need to spend a listServiceTypes call
    // resolving it.
    const plans = await pco.listPlans(
      { id: serviceTypeId, name: null },
      { filter: 'past', perPage, order: '-sort_date' },
    )
    // Only fetch items for plans that could land in either band. Older
    // plans carry no restriction, so their items are wasted calls.
    const inWindow = plans.filter(
      (p) =>
        p.sortDate && daysBetween(p.sortDate, now) <= windows.reducedWeightDays,
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
    // The two counts that explain the size of the rendered block: how
    // many services were scanned, and how much duplication collapses
    // out. A block that looks bigger than expected is almost always
    // more plans in the window than expected, or titles that differ
    // enough that normalizeText won't collapse them.
    const { blocked, reduced } = bucketRecentSongs(songs, now, windows)
    console.log(
      `[recentSongs] fetched in ${Date.now() - startedAt}ms: ${plans.length} plans listed, ${inWindow.length} in window (${windows.reducedWeightDays}d), ${songs.length} song slots → ${blocked.length + reduced.length} unique (${blocked.length} blocked, ${reduced.length} reduced)`,
    )
    if (inWindow.length > 0) {
      const perService = inWindow
        .map((p, i) => `${p.sortDate?.slice(0, 10)}(${perPlan[i].length})`)
        .join(', ')
      console.log(`[recentSongs] services: ${perService}`)
    }
  } catch (err) {
    console.warn('[recentSongs] fetch failed; continuing without it:', err)
    return []
  }

  ref
    .set({
      songs,
      fetchedAt: now.getTime(),
      scannedDays: windows.reducedWeightDays,
    } satisfies CacheDoc)
    .catch(() => {})
  return songs
}
