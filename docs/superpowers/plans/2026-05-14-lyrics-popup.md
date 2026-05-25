# Lyrics Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "view lyrics" button that opens an in-app modal showing lyrics fetched from LRCLIB. The button sits in three places: (a) inline at the end of the chorus-snippet line on active candidate cards, **replacing the small `chip chip-ai` badge** that currently lives there (snippet text and curly-quote framing stay); (b) inline at the end of the rejected-snippet line on rejected cards, with the same surgical chip replacement; (c) on filled slot rows alongside the existing brand-icon `SongLookupLinks`. Cache results server-side in Firestore so each song is fetched at most once.

**Architecture:** New `getLyrics` callable in Cloud Functions wraps an LRCLIB HTTP client + a Firestore cache keyed by a hash of normalized `(title, author)`. The SPA gets a typed callable wrapper, a `LyricsButton` component that owns its own modal state with two visual variants (`chip` for the inline placements inside the snippet lines — sized to match the `.chip` family it replaces; `icon` for the slot-row placement), and wiring into all three render sites in `PlanDetail.tsx`. Caching is server-side only (no client cache) because Firestore reads are fast and the result is identical across users. Negative results are cached too, with a manual "Re-check LRCLIB" button as the escape hatch. **No Genius fallback** — PraiseCharts is already in the existing `SongLookupLinks` row beside the lyrics button on every site, so the not-found modal just points the user there.

**Tech Stack:** TypeScript, React 19, Firebase Functions Gen 2, Firestore (admin SDK), LRCLIB HTTP API, Vitest.

---

## File Structure

**New files (Cloud Functions):**
- `functions/src/normalize.ts` — extracted shared title-normalization helper (refactor from `pco/titleMatch.ts`)
- `functions/src/normalize.test.ts` — tests for the extracted helper
- `functions/src/lyrics/lrclib.ts` — LRCLIB HTTP client
- `functions/src/lyrics/lrclib.test.ts` — LRCLIB client tests (mocked fetch)
- `functions/src/lyrics/cache.ts` — Firestore cache read/write + key derivation
- `functions/src/lyrics/cache.test.ts` — cache tests (Firestore injected)
- `functions/src/lyrics/index.ts` — orchestration (cache-then-fetch)
- `functions/src/lyrics/index.test.ts` — orchestrator tests with both deps mocked

**New files (SPA):**
- `src/components/LyricsButton.tsx` — icon button + modal (state + rendering co-located; one feature, one file)

**Modified files:**
- `functions/src/pco/titleMatch.ts` — import `normalize` from new shared module instead of defining locally
- `functions/src/index.ts` — register new `getLyrics` callable (mirrors `searchSongs` pattern)
- `firestore.rules` — deny client access to new `lyrics/{cacheKey}` collection
- `src/lib/api.ts` — typed `getLyrics` callable wrapper
- `src/components/PlanDetail.tsx` — three changes:
  - On the active candidate card's `chorus-snippet` div (around line 938): keep the snippet text and curly quotes; remove **only** the `<span className="chip chip-ai">…</span>` block at the end (the sparkle + "AI" badge); insert `<LyricsButton variant="chip" />` in its place.
  - On the rejected card's `rejected-snippet` div (around line 689): same surgical change — keep the snippet text, remove only the `chip chip-ai` span, insert `<LyricsButton variant="chip" />`.
  - On the slot row's `lookup-row` (around line 460): insert `<LyricsButton variant="icon" />` next to `SongLookupLinks`.
- `src/index.css` — modal overlay + card styles

**Test strategy (per CLAUDE.md):**
- Pure helpers (normalize, cache key derivation, LRCLIB URL/response parsing) tested directly.
- Orchestrator tested with mocked LRCLIB client + mocked Firestore (dependency injection — see Task 4).
- Callable wrapper tested via the orchestrator; no separate test for `functions/src/index.ts` registration.
- React component is **not** unit-tested (per the "test the seam, not the rendering" rule in CLAUDE.md). Manual smoke test at the end of the plan covers the UI.

---

## Task 1: Extract `normalize` into shared module

Today the `normalize` function in `functions/src/pco/titleMatch.ts` is the right normalization for our cache key (lowercase, NFKC, strip articles, `&`→`and`, curly quote folding). It's currently private to that file. Extract it to a shared module so the new lyrics cache key can reuse it without duplicating the spec.

**Files:**
- Create: `functions/src/normalize.ts`
- Create: `functions/src/normalize.test.ts`
- Modify: `functions/src/pco/titleMatch.ts`

- [ ] **Step 1: Write the failing test for the extracted helper**

Create `functions/src/normalize.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { normalizeText } from './normalize'

describe('normalizeText', () => {
  it('lowercases and trims', () => {
    expect(normalizeText('  Reckless Love  ')).toBe('reckless love')
  })

  it('folds curly apostrophes to straight', () => {
    expect(normalizeText('It’s Your Breath')).toBe("it's your breath")
  })

  it('folds curly double quotes to straight', () => {
    expect(normalizeText('“Holy”')).toBe('"holy"')
  })

  it('treats "&" as "and"', () => {
    expect(normalizeText('Bread & Wine')).toBe('bread and wine')
  })

  it('collapses runs of whitespace', () => {
    expect(normalizeText('Holy   Spirit')).toBe('holy spirit')
  })

  it('strips a single leading article', () => {
    expect(normalizeText('The Lion and the Lamb')).toBe('lion and the lamb')
    expect(normalizeText('A Mighty Fortress')).toBe('mighty fortress')
    expect(normalizeText('An Hour With Jesus')).toBe('hour with jesus')
  })

  it('applies NFKC compatibility normalization', () => {
    // U+FB01 (ﬁ ligature) NFKC-decomposes to "fi"
    expect(normalizeText('Sanctiﬁed')).toBe('sanctified')
  })

  it('returns empty string when given empty input', () => {
    expect(normalizeText('')).toBe('')
    expect(normalizeText('   ')).toBe('')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test -- functions/src/normalize.test.ts
```

Expected: FAIL with "Cannot find module './normalize'" or similar.

- [ ] **Step 3: Create `functions/src/normalize.ts`**

```typescript
// Lowercase + light folding for comparing song-identifying strings
// (titles, authors) across sources that render the same value in
// inconsequentially different ways: CCLI's curly apostrophes,
// publisher-style "&" vs lyrics-style "and", leading articles that
// some catalogs include and others omit, NFKC compatibility forms
// from font ligatures.
//
// Deliberately NOT fuzzy: no edit-distance tolerance, no token
// reordering, no stop-word removal beyond a single leading article.
// Used by titlesMatch (PCO library lookup) and the lyrics cache key.
// Anything more aggressive risks collapsing distinct songs.
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:the|a|an)\s+/, '')
    .trim()
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test -- functions/src/normalize.test.ts
```

Expected: PASS (8 assertions).

- [ ] **Step 5: Refactor `titleMatch.ts` to use the shared helper**

Open `functions/src/pco/titleMatch.ts`. Replace the entire local `function normalize(...)` block with an import:

```typescript
// Compares two song titles for "same song" purposes when matching an
// AI-proposed title against a Planning Center library entry. A pure
// equality check is too strict — it misses real matches over leading
// articles ("Lion and the Lamb" vs "The Lion and the Lamb"), curly
// vs straight apostrophes (CCLI-paste artifact), and "&" vs "and"
// (publisher-style vs lyrics-style rendering of the same title).
//
// Deliberately NOT fuzzy: no edit-distance tolerance, no token
// reordering, no stop-word removal beyond a leading article. The
// false-positive risk on worship titles is real — see the
// "I Surrender" / "Surrender" case in PCO's substring filter that
// motivated the original strict equality. Normalization here only
// drops differences that are virtually never meaningful.
import { normalizeText } from '../normalize'

export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return false
  return na === nb
}
```

- [ ] **Step 6: Run the existing titleMatch tests to verify the refactor is non-breaking**

```bash
npm test -- functions/src/pco/titleMatch.test.ts
```

Expected: PASS (all 10 existing tests still green).

- [ ] **Step 7: Run the full test suite**

```bash
npm test
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git checkout -b lyrics-popup
git add functions/src/normalize.ts functions/src/normalize.test.ts functions/src/pco/titleMatch.ts
git commit -m "Extract title normalization into shared helper"
```

---

## Task 2: LRCLIB HTTP client

Thin wrapper around LRCLIB's `GET /api/get` endpoint with title + author query. No API key required. Treats HTTP 200 as found, 404 as not-found, all other statuses as errors. Returns a normalized result shape; never throws on "not found".

**Files:**
- Create: `functions/src/lyrics/lrclib.ts`
- Create: `functions/src/lyrics/lrclib.test.ts`

**LRCLIB response shape (200 OK):**

```json
{
  "id": 3396226,
  "trackName": "I Want to Live",
  "artistName": "Borislav Slavov",
  "albumName": "Baldur's Gate 3",
  "duration": 233,
  "instrumental": false,
  "plainLyrics": "...",
  "syncedLyrics": "[00:17.12] I feel ..."
}
```

**LRCLIB 404 body:**

```json
{ "code": 404, "name": "TrackNotFound", "message": "Failed to find specified track" }
```

- [ ] **Step 1: Write the failing tests**

Create `functions/src/lyrics/lrclib.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchFromLrclib } from './lrclib'

describe('fetchFromLrclib', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hits the LRCLIB /api/get endpoint with URL-encoded title + author', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 1,
        trackName: 'Reckless Love',
        artistName: 'Cory Asbury',
        albumName: null,
        duration: 240,
        instrumental: false,
        plainLyrics: 'Before I spoke a word\nYou were singing over me',
        syncedLyrics: null,
      }),
    } as Response)

    await fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://lrclib.net/api/get?artist_name=Cory%20Asbury&track_name=Reckless%20Love',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('returns a found result with plain lyrics on 200', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 42,
        trackName: 'Reckless Love',
        artistName: 'Cory Asbury',
        albumName: null,
        duration: 240,
        instrumental: false,
        plainLyrics: 'Before I spoke a word',
        syncedLyrics: null,
      }),
    } as Response)

    const result = await fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' })

    expect(result).toEqual({
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
    })
  })

  it('returns an instrumental result when LRCLIB marks the track instrumental', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 7,
        trackName: 'Interlude',
        artistName: 'Some Artist',
        albumName: null,
        duration: 60,
        instrumental: true,
        plainLyrics: null,
        syncedLyrics: null,
      }),
    } as Response)

    const result = await fetchFromLrclib({ title: 'Interlude', author: 'Some Artist' })

    expect(result).toEqual({
      found: true,
      plainLyrics: null,
      instrumental: true,
      lrclibId: 7,
    })
  })

  it('returns a not-found result on HTTP 404', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        code: 404,
        name: 'TrackNotFound',
        message: 'Failed to find specified track',
      }),
    } as Response)

    const result = await fetchFromLrclib({ title: 'Nonexistent', author: 'Nobody' })

    expect(result).toEqual({
      found: false,
      plainLyrics: null,
      instrumental: false,
      lrclibId: null,
    })
  })

  it('omits artist_name from the URL when author is missing', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ code: 404 }),
    } as Response)

    await fetchFromLrclib({ title: 'Reckless Love' })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://lrclib.net/api/get?track_name=Reckless%20Love',
      expect.anything(),
    )
  })

  it('throws on a non-200/404 status', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response)

    await expect(
      fetchFromLrclib({ title: 'Reckless Love', author: 'Cory Asbury' }),
    ).rejects.toThrow(/lrclib/i)
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test -- functions/src/lyrics/lrclib.test.ts
```

Expected: FAIL with "Cannot find module './lrclib'".

- [ ] **Step 3: Implement the LRCLIB client**

Create `functions/src/lyrics/lrclib.ts`:

```typescript
// LRCLIB is a free, no-API-key lyrics service. We use its
// /api/get endpoint which returns one exact-match track or 404.
// Not the /api/search endpoint — that returns ranked candidates
// and would need disambiguation; LRCLIB's internal matching on
// (artist, title) is good enough for our hit rate target.

const LRCLIB_BASE_URL = 'https://lrclib.net/api/get'

export interface LrclibQuery {
  title: string
  author?: string
}

export interface LrclibResult {
  found: boolean
  plainLyrics: string | null
  instrumental: boolean
  lrclibId: number | null
}

interface LrclibTrackResponse {
  id: number
  trackName: string
  artistName: string
  albumName: string | null
  duration: number | null
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

export async function fetchFromLrclib(query: LrclibQuery): Promise<LrclibResult> {
  const params = new URLSearchParams()
  if (query.author) params.set('artist_name', query.author)
  params.set('track_name', query.title)
  const url = `${LRCLIB_BASE_URL}?${params.toString()}`

  const res = await fetch(url, { method: 'GET' })

  if (res.status === 404) {
    return { found: false, plainLyrics: null, instrumental: false, lrclibId: null }
  }
  if (!res.ok) {
    throw new Error(`LRCLIB request failed: HTTP ${res.status}`)
  }

  const body = (await res.json()) as LrclibTrackResponse
  return {
    found: true,
    plainLyrics: body.plainLyrics,
    instrumental: body.instrumental,
    lrclibId: body.id,
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test -- functions/src/lyrics/lrclib.test.ts
```

Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add functions/src/lyrics/lrclib.ts functions/src/lyrics/lrclib.test.ts
git commit -m "Add LRCLIB HTTP client"
```

---

## Task 3: Lyrics cache layer

Read/write a per-song cache document in Firestore. Cache key is derived from the normalized title + author (using the helper from Task 1). The cache module takes a `Firestore` instance as a parameter rather than importing one at module level — this makes it trivially mockable in tests and matches the dependency-injection seam used elsewhere in the functions codebase.

**Files:**
- Create: `functions/src/lyrics/cache.ts`
- Create: `functions/src/lyrics/cache.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `functions/src/lyrics/cache.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'

import { lyricsCacheKey, readLyricsCache, writeLyricsCache } from './cache'

describe('lyricsCacheKey', () => {
  it('produces a stable 40-char hex hash for a given title+author', () => {
    const key = lyricsCacheKey('Reckless Love', 'Cory Asbury')
    expect(key).toMatch(/^[0-9a-f]{40}$/)
    expect(key).toBe(lyricsCacheKey('Reckless Love', 'Cory Asbury'))
  })

  it('treats normalized-equivalent inputs as the same key', () => {
    expect(lyricsCacheKey('Reckless Love', 'Cory Asbury')).toBe(
      lyricsCacheKey('  RECKLESS LOVE  ', 'cory asbury'),
    )
    expect(lyricsCacheKey('The Lion and the Lamb', 'Bethel')).toBe(
      lyricsCacheKey('Lion and the Lamb', 'Bethel'),
    )
    expect(lyricsCacheKey('Bread & Wine', 'Hillsong')).toBe(
      lyricsCacheKey('Bread and Wine', 'Hillsong'),
    )
  })

  it('produces different keys for different songs', () => {
    expect(lyricsCacheKey('Reckless Love', 'Cory Asbury')).not.toBe(
      lyricsCacheKey('Holy Spirit', 'Bryan & Katie Torwalt'),
    )
  })

  it('produces different keys for same title, different authors', () => {
    expect(lyricsCacheKey('Surrender', 'Marc James')).not.toBe(
      lyricsCacheKey('Surrender', 'Hillsong'),
    )
  })

  it('treats missing author the same as empty string', () => {
    expect(lyricsCacheKey('Reckless Love')).toBe(
      lyricsCacheKey('Reckless Love', ''),
    )
  })
})

function makeFakeDb() {
  // Minimal Firestore-shaped stub: collection().doc().get()/set() chain.
  const store = new Map<string, unknown>()
  return {
    store,
    collection(name: string) {
      expect(name).toBe('lyrics')
      return {
        doc(key: string) {
          return {
            async get() {
              const data = store.get(key)
              return {
                exists: data !== undefined,
                data: () => data,
              }
            },
            async set(value: unknown) {
              store.set(key, value)
            },
          }
        },
      }
    },
  }
}

describe('readLyricsCache', () => {
  it('returns null when no doc exists for the key', async () => {
    const fakeDb = makeFakeDb()
    const result = await readLyricsCache(
      fakeDb as unknown as Parameters<typeof readLyricsCache>[0],
      'Reckless Love',
      'Cory Asbury',
    )
    expect(result).toBeNull()
  })

  it('returns the cached entry when one exists', async () => {
    const fakeDb = makeFakeDb()
    const key = lyricsCacheKey('Reckless Love', 'Cory Asbury')
    fakeDb.store.set(key, {
      title: 'Reckless Love',
      author: 'Cory Asbury',
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
      source: 'lrclib',
      fetchedAt: 1700000000000,
    })

    const result = await readLyricsCache(
      fakeDb as unknown as Parameters<typeof readLyricsCache>[0],
      'Reckless Love',
      'Cory Asbury',
    )
    expect(result).toEqual({
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
      source: 'lrclib',
      fetchedAt: 1700000000000,
    })
  })
})

describe('writeLyricsCache', () => {
  it('writes the entry under the derived key and includes title+author for debugging', async () => {
    const fakeDb = makeFakeDb()
    const now = vi.fn().mockReturnValue(1700000000000)

    await writeLyricsCache(
      fakeDb as unknown as Parameters<typeof writeLyricsCache>[0],
      'Reckless Love',
      'Cory Asbury',
      {
        found: true,
        plainLyrics: 'Before I spoke a word',
        instrumental: false,
        lrclibId: 42,
      },
      now,
    )

    const key = lyricsCacheKey('Reckless Love', 'Cory Asbury')
    expect(fakeDb.store.get(key)).toEqual({
      title: 'Reckless Love',
      author: 'Cory Asbury',
      found: true,
      plainLyrics: 'Before I spoke a word',
      instrumental: false,
      lrclibId: 42,
      source: 'lrclib',
      fetchedAt: 1700000000000,
    })
  })

  it('stores empty-string author when none was supplied', async () => {
    const fakeDb = makeFakeDb()
    await writeLyricsCache(
      fakeDb as unknown as Parameters<typeof writeLyricsCache>[0],
      'Reckless Love',
      undefined,
      { found: false, plainLyrics: null, instrumental: false, lrclibId: null },
      () => 1700000000000,
    )

    const key = lyricsCacheKey('Reckless Love')
    const entry = fakeDb.store.get(key) as { author: string }
    expect(entry.author).toBe('')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test -- functions/src/lyrics/cache.test.ts
```

Expected: FAIL with "Cannot find module './cache'".

- [ ] **Step 3: Implement the cache module**

Create `functions/src/lyrics/cache.ts`:

```typescript
import { createHash } from 'node:crypto'

import type { Firestore } from 'firebase-admin/firestore'

import { normalizeText } from '../normalize'

// Lyrics cache lives in a top-level Firestore collection because the
// data is identical across users — the same song has the same lyrics
// regardless of which Planning Center library it came from. Sharing
// the cache means we pay LRCLIB once per song globally rather than
// once per user. Client access is denied (see firestore.rules); only
// the getLyrics callable reads/writes via admin SDK.
const COLLECTION = 'lyrics'

export interface LyricsCacheEntry {
  found: boolean
  plainLyrics: string | null
  instrumental: boolean
  lrclibId: number | null
  source: 'lrclib'
  fetchedAt: number
}

interface LyricsCacheDoc extends LyricsCacheEntry {
  // Stored for human debugging only. Lookups go through lyricsCacheKey
  // which normalizes — these strings reflect what the caller sent.
  title: string
  author: string
}

export function lyricsCacheKey(title: string, author?: string): string {
  const t = normalizeText(title)
  const a = normalizeText(author ?? '')
  return createHash('sha1').update(`${t}|${a}`).digest('hex')
}

export async function readLyricsCache(
  db: Firestore,
  title: string,
  author: string | undefined,
): Promise<LyricsCacheEntry | null> {
  const key = lyricsCacheKey(title, author)
  const snap = await db.collection(COLLECTION).doc(key).get()
  if (!snap.exists) return null
  const data = snap.data() as LyricsCacheDoc | undefined
  if (!data) return null
  return {
    found: data.found,
    plainLyrics: data.plainLyrics,
    instrumental: data.instrumental,
    lrclibId: data.lrclibId,
    source: data.source,
    fetchedAt: data.fetchedAt,
  }
}

export async function writeLyricsCache(
  db: Firestore,
  title: string,
  author: string | undefined,
  result: {
    found: boolean
    plainLyrics: string | null
    instrumental: boolean
    lrclibId: number | null
  },
  now: () => number = Date.now,
): Promise<void> {
  const key = lyricsCacheKey(title, author)
  const doc: LyricsCacheDoc = {
    title,
    author: author ?? '',
    found: result.found,
    plainLyrics: result.plainLyrics,
    instrumental: result.instrumental,
    lrclibId: result.lrclibId,
    source: 'lrclib',
    fetchedAt: now(),
  }
  await db.collection(COLLECTION).doc(key).set(doc)
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test -- functions/src/lyrics/cache.test.ts
```

Expected: PASS (10 assertions).

- [ ] **Step 5: Commit**

```bash
git add functions/src/lyrics/cache.ts functions/src/lyrics/cache.test.ts
git commit -m "Add Firestore lyrics cache layer"
```

---

## Task 4: Orchestrator (cache-then-fetch)

A single function `getLyricsForSong` that:

1. Checks the Firestore cache by `(title, author)` key.
2. If found and `!forceRefresh`, returns the cached entry tagged `fromCache: true`.
3. Otherwise, calls `fetchFromLrclib`, writes the result to cache, and returns it tagged `fromCache: false`.

Both dependencies (the cache module and the LRCLIB fetcher) are passed in as parameters so the orchestrator stays trivially testable.

**Files:**
- Create: `functions/src/lyrics/index.ts`
- Create: `functions/src/lyrics/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `functions/src/lyrics/index.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'

import { getLyricsForSong } from './index'
import type { LrclibResult } from './lrclib'
import type { LyricsCacheEntry } from './cache'

describe('getLyricsForSong', () => {
  it('returns the cached entry on a hit and does not call LRCLIB', async () => {
    const cached: LyricsCacheEntry = {
      found: true,
      plainLyrics: 'Cached lyrics body',
      instrumental: false,
      lrclibId: 42,
      source: 'lrclib',
      fetchedAt: 1700000000000,
    }
    const deps = {
      readCache: vi.fn().mockResolvedValue(cached),
      writeCache: vi.fn().mockResolvedValue(undefined),
      fetchLrclib: vi.fn(),
    }

    const result = await getLyricsForSong(
      { title: 'Reckless Love', author: 'Cory Asbury' },
      deps,
    )

    expect(deps.readCache).toHaveBeenCalledWith('Reckless Love', 'Cory Asbury')
    expect(deps.fetchLrclib).not.toHaveBeenCalled()
    expect(deps.writeCache).not.toHaveBeenCalled()
    expect(result).toEqual({
      found: true,
      plainLyrics: 'Cached lyrics body',
      instrumental: false,
      source: 'lrclib',
      fetchedAt: 1700000000000,
      fromCache: true,
    })
  })

  it('calls LRCLIB and writes the cache on a miss', async () => {
    const lrclibResult: LrclibResult = {
      found: true,
      plainLyrics: 'Fresh lyrics body',
      instrumental: false,
      lrclibId: 99,
    }
    const deps = {
      readCache: vi.fn().mockResolvedValue(null),
      writeCache: vi.fn().mockResolvedValue(undefined),
      fetchLrclib: vi.fn().mockResolvedValue(lrclibResult),
    }

    const result = await getLyricsForSong(
      { title: 'Reckless Love', author: 'Cory Asbury' },
      deps,
    )

    expect(deps.fetchLrclib).toHaveBeenCalledWith({
      title: 'Reckless Love',
      author: 'Cory Asbury',
    })
    expect(deps.writeCache).toHaveBeenCalledWith(
      'Reckless Love',
      'Cory Asbury',
      lrclibResult,
    )
    expect(result).toMatchObject({
      found: true,
      plainLyrics: 'Fresh lyrics body',
      instrumental: false,
      source: 'lrclib',
      fromCache: false,
    })
    expect(typeof result.fetchedAt).toBe('number')
  })

  it('caches a negative result so the next call is a hit', async () => {
    const lrclibResult: LrclibResult = {
      found: false,
      plainLyrics: null,
      instrumental: false,
      lrclibId: null,
    }
    const deps = {
      readCache: vi.fn().mockResolvedValue(null),
      writeCache: vi.fn().mockResolvedValue(undefined),
      fetchLrclib: vi.fn().mockResolvedValue(lrclibResult),
    }

    await getLyricsForSong({ title: 'Nonexistent', author: 'Nobody' }, deps)

    expect(deps.writeCache).toHaveBeenCalledWith(
      'Nonexistent',
      'Nobody',
      lrclibResult,
    )
  })

  it('bypasses the cache when forceRefresh is true and overwrites with the fresh result', async () => {
    const cached: LyricsCacheEntry = {
      found: false,
      plainLyrics: null,
      instrumental: false,
      lrclibId: null,
      source: 'lrclib',
      fetchedAt: 1700000000000,
    }
    const lrclibResult: LrclibResult = {
      found: true,
      plainLyrics: 'Now found',
      instrumental: false,
      lrclibId: 7,
    }
    const deps = {
      readCache: vi.fn().mockResolvedValue(cached),
      writeCache: vi.fn().mockResolvedValue(undefined),
      fetchLrclib: vi.fn().mockResolvedValue(lrclibResult),
    }

    const result = await getLyricsForSong(
      { title: 'Reckless Love', author: 'Cory Asbury', forceRefresh: true },
      deps,
    )

    expect(deps.fetchLrclib).toHaveBeenCalled()
    expect(deps.writeCache).toHaveBeenCalledWith(
      'Reckless Love',
      'Cory Asbury',
      lrclibResult,
    )
    expect(result.found).toBe(true)
    expect(result.fromCache).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test -- functions/src/lyrics/index.test.ts
```

Expected: FAIL with "Cannot find module './index'".

- [ ] **Step 3: Implement the orchestrator**

Create `functions/src/lyrics/index.ts`:

```typescript
import type { Firestore } from 'firebase-admin/firestore'

import {
  readLyricsCache,
  writeLyricsCache,
  type LyricsCacheEntry,
} from './cache'
import { fetchFromLrclib, type LrclibResult } from './lrclib'

export interface GetLyricsRequest {
  title: string
  author?: string
  /** Skip the cache read and re-query LRCLIB. The fresh result is
   *  written back into the cache, replacing any prior value. Used
   *  for the modal's manual "Re-check LRCLIB" button. */
  forceRefresh?: boolean
}

export interface GetLyricsResult {
  found: boolean
  plainLyrics: string | null
  instrumental: boolean
  source: 'lrclib'
  fetchedAt: number
  fromCache: boolean
}

interface OrchestratorDeps {
  readCache(title: string, author: string | undefined): Promise<LyricsCacheEntry | null>
  writeCache(
    title: string,
    author: string | undefined,
    result: LrclibResult,
  ): Promise<void>
  fetchLrclib(query: { title: string; author?: string }): Promise<LrclibResult>
}

export async function getLyricsForSong(
  req: GetLyricsRequest,
  deps: OrchestratorDeps,
): Promise<GetLyricsResult> {
  if (!req.forceRefresh) {
    const cached = await deps.readCache(req.title, req.author)
    if (cached) {
      return {
        found: cached.found,
        plainLyrics: cached.plainLyrics,
        instrumental: cached.instrumental,
        source: cached.source,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
      }
    }
  }

  const fresh = await deps.fetchLrclib({ title: req.title, author: req.author })
  await deps.writeCache(req.title, req.author, fresh)
  return {
    found: fresh.found,
    plainLyrics: fresh.plainLyrics,
    instrumental: fresh.instrumental,
    source: 'lrclib',
    fetchedAt: Date.now(),
    fromCache: false,
  }
}

// Default-deps factory wires the orchestrator to real Firestore + LRCLIB.
// The callable in index.ts uses this; tests inject their own deps.
export function defaultLyricsDeps(db: Firestore): OrchestratorDeps {
  return {
    readCache: (title, author) => readLyricsCache(db, title, author),
    writeCache: (title, author, result) => writeLyricsCache(db, title, author, result),
    fetchLrclib: (q) => fetchFromLrclib(q),
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test -- functions/src/lyrics/index.test.ts
```

Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add functions/src/lyrics/index.ts functions/src/lyrics/index.test.ts
git commit -m "Add lyrics orchestrator with cache-then-fetch"
```

---

## Task 5: Register the `getLyrics` callable

Wire the orchestrator into the Cloud Functions surface so the SPA can call it. Mirrors the `searchSongs` pattern. Auth is `requireAllowed` (any allowed user, not admin-only).

**Files:**
- Modify: `functions/src/index.ts`

- [ ] **Step 1: Read the area around `searchSongs` to confirm the import block and the `pcoForUser` / `requireAllowed` patterns**

```bash
sed -n '1,30p' functions/src/index.ts
sed -n '273,300p' functions/src/index.ts
```

Note the existing imports and where new callables are appended (near the end of the file is conventional — find a sensible spot, e.g., after the last `onCall(...)` definition but before any `metrics`-related callables).

- [ ] **Step 2: Add the imports**

At the top of `functions/src/index.ts`, alongside the existing imports (preserve alphabetical order if the file follows one):

```typescript
import { getFirestore } from 'firebase-admin/firestore'

import { defaultLyricsDeps, getLyricsForSong } from './lyrics'
```

Note: `firebase-admin/firestore` may already be imported transitively; if so, just add the new symbol to the existing import or skip if it's already there. Search the file with `grep -n "firebase-admin/firestore" functions/src/index.ts` first.

- [ ] **Step 3: Add the callable**

Append after the last existing `onCall(...)` block (or alongside read-only callables like `searchSongs`):

```typescript
// On-demand lyrics lookup for the candidate-card / slot-row modal.
// Wraps LRCLIB behind a shared Firestore cache so each (title, author)
// is fetched at most once across all users. Negative results are
// cached too — the modal exposes a "Re-check LRCLIB" button that sets
// forceRefresh: true when the user wants to try again.
export const getLyrics = onCall(async (req) => {
  await requireAllowed(req)
  const { title, author, forceRefresh } = req.data as {
    title?: string
    author?: string
    forceRefresh?: boolean
  }
  if (!title || typeof title !== 'string') {
    throw new HttpsError('invalid-argument', 'title required')
  }
  const db = getFirestore()
  const result = await getLyricsForSong(
    {
      title: title.trim(),
      author: typeof author === 'string' && author.trim() ? author.trim() : undefined,
      forceRefresh: forceRefresh === true,
    },
    defaultLyricsDeps(db),
  )
  return result
})
```

- [ ] **Step 4: Build the functions package to catch type errors**

```bash
npm --prefix functions run build
```

Expected: exits 0, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add functions/src/index.ts
git commit -m "Register getLyrics callable"
```

---

## Task 6: Firestore security rule for the lyrics collection

Deny all client access to the new `lyrics/{cacheKey}` collection. Only the admin SDK (i.e., the `getLyrics` callable) reads or writes.

**Files:**
- Modify: `firestore.rules`

- [ ] **Step 1: Read the existing rules to find the right insertion point**

```bash
cat firestore.rules
```

Note: the file ends with a catch-all `match /{document=**} { allow read, write: if false; }`. The new rule must go **before** that catch-all to be matched specifically (even though both deny — being specific makes the intent visible to anyone reading the file).

- [ ] **Step 2: Insert the new rule**

After the `slotPlaceholders` block (around line 56), add:

```
// Shared cross-user cache of song lyrics fetched from LRCLIB. The
// getLyrics Cloud Function reads/writes via admin SDK; clients
// always go through the callable, never read here directly.
match /lyrics/{cacheKey} {
  allow read, write: if false;
}
```

- [ ] **Step 3: Verify the rules file still parses**

```bash
firebase emulators:start --only firestore --import=.emulator-data --export-on-exit=.emulator-data &
FIREBASE_PID=$!
sleep 5
kill $FIREBASE_PID 2>/dev/null
wait $FIREBASE_PID 2>/dev/null
```

Expected: emulator logs show "rules-validation: rules-loaded successfully" (or equivalent) before being killed.

Alternative: just visually inspect the file for syntax — Firestore rules are simple enough that this is fine if running the emulator feels heavy.

- [ ] **Step 4: Commit**

```bash
git add firestore.rules
git commit -m "Deny client access to lyrics cache collection"
```

---

## Task 7: SPA client callable wrapper

Add a typed `httpsCallable` wrapper for `getLyrics` to `src/lib/api.ts`. Mirrors the existing patterns (single input object, single output object).

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the typed wrapper**

Append to `src/lib/api.ts`, after the existing `searchSongs`/`getSong` block (around line 257):

```typescript
export interface LyricsResult {
  found: boolean
  plainLyrics: string | null
  instrumental: boolean
  source: 'lrclib'
  /** Epoch ms when this entry was last fetched from LRCLIB. Lets the
   *  modal show a "last checked X ago" hint and the manual refresh
   *  button. */
  fetchedAt: number
  /** True iff the server returned the previously-cached value rather
   *  than calling LRCLIB on this request. */
  fromCache: boolean
}

/** On-demand lyrics lookup, cached server-side. `forceRefresh: true`
 *  bypasses the cache and re-queries LRCLIB (used by the modal's
 *  "Re-check LRCLIB" button when an earlier negative result might be
 *  stale). */
export const getLyrics = httpsCallable<
  { title: string; author?: string; forceRefresh?: boolean },
  LyricsResult
>(functions, 'getLyrics')
```

- [ ] **Step 2: Build the SPA to catch type errors**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "Add typed getLyrics client callable"
```

---

## Task 8: `LyricsButton` component

A self-contained component that renders the trigger button and the modal. State lives inside the component: `open`, `loading`, `result`, `error`. Click outside or Escape closes the modal. Caching is server-side only — every open triggers a callable call, which returns instantly on cache hits.

The trigger has two visual variants:

- **`variant="chip"`** — a small inline pill ("Lyrics" + small lyric-lines icon) sized to match the existing `.chip` family. Used inline at the end of the `chorus-snippet` / `rejected-snippet` text, where it **directly replaces** the `<span className="chip chip-ai">` badge that currently sits there. Matches the chip family in pill shape, padding, and font size so the snippet line still reads as a single visual unit; differs from `chip-ai` in that it carries a neutral border (no AI gradient — LRCLIB lyrics aren't AI-generated) and is interactive (button affordances: cursor pointer, hover state).
- **`variant="icon"`** — icon-only at `iconbtn-sm` size. Used on filled slot rows, where the `lookup-row` already uses `sm` sizing for SongLookupLinks.

**No Genius fallback in the not-found state.** PraiseCharts is in the existing `SongLookupLinks` row right beside the lyrics button on the slot row, and is also reachable from the candidate card's `listen-actions` row — when LRCLIB has no match, the modal just points the user to PraiseCharts. No external Genius link, no Genius API.

**Candidates without a `chorusSnippet` get no lyrics button on the card** — the chip variant lives inside the snippet div, which only renders when a snippet exists. This matches the user's surgical "replace only the AI icon inside it" framing. Such candidates are rare (the AI is prompted to provide snippets), and the user can still reach lyrics via the PraiseCharts link in `listen-actions`.

**Files:**
- Create: `src/components/LyricsButton.tsx`

- [ ] **Step 1: Inspect the existing `.chip` and `.chip-ai` rules so the new chip variant matches the family**

```bash
sed -n '2340,2410p' src/index.css
grep -n "iconbtn\|SongLookupLinks\|chip chip-" src/components/PlanDetail.tsx | head -20
```

Anchor sizes for the new chip variant (from `src/index.css`):
- Base `.chip`: `font-size: 0.76rem`, `padding: 0.18rem 0.55rem`, `border-radius: 999px`.
- `.chip-ai` (what we're replacing): even smaller font (`0.62rem`), tighter padding, but visually anchored to the end of the snippet via `margin-left: 0.4rem`.

The new `.lyrics-chip` matches the base `.chip` font and padding (slightly larger than `chip-ai` to leave room for the icon + "Lyrics" label without cramping), carries a neutral border (no AI gradient), and adds button-affordance styling (cursor, hover state).

- [ ] **Step 2: Create the component**

Create `src/components/LyricsButton.tsx`:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'

import { getLyrics, type LyricsResult } from '../lib/api'

interface LyricsButtonProps {
  title: string
  author?: string | null
  /** Visual treatment — `chip` is a labeled pill ("Lyrics" + icon),
   *  `icon` is icon-only at iconbtn-sm size. The chip variant carries
   *  its label because it replaces the chorus-snippet text that
   *  active candidate cards used to show — keeping a label there
   *  preserves recognizability where the row used to have prose. */
  variant: 'chip' | 'icon'
}

function LyricsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4h10M3 8h10M3 12h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function LyricsButton({ title, author, variant }: LyricsButtonProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<LyricsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const cleanAuthor = author?.trim() || undefined

  const load = useCallback(
    async (forceRefresh: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const res = await getLyrics({
          title: title.trim(),
          author: cleanAuthor,
          forceRefresh,
        })
        setResult(res.data)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to fetch lyrics'
        setError(message)
      } finally {
        setLoading(false)
      }
    },
    [title, cleanAuthor],
  )

  const handleOpen = useCallback(() => {
    setOpen(true)
    if (!result) void load(false)
  }, [result, load])

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [])

  // Escape closes; click outside the modal card closes.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    function onClick(e: MouseEvent) {
      const el = dialogRef.current
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [open])

  return (
    <>
      {variant === 'chip' ? (
        <button
          type="button"
          className="lyrics-chip"
          title="View lyrics"
          aria-label={`View lyrics for ${title}`}
          onClick={handleOpen}
        >
          <LyricsIcon />
          <span>Lyrics</span>
        </button>
      ) : (
        <button
          type="button"
          className="iconbtn iconbtn-sm iconbtn-lyrics"
          title="View lyrics"
          aria-label={`View lyrics for ${title}`}
          onClick={handleOpen}
        >
          <LyricsIcon />
        </button>
      )}
      {open && (
        <div className="lyrics-modal-backdrop" role="presentation">
          <div
            className="lyrics-modal-card"
            role="dialog"
            aria-modal="true"
            aria-label={`Lyrics for ${title}`}
            ref={dialogRef}
          >
            <header className="lyrics-modal-header">
              <div className="lyrics-modal-title">
                <strong>{title}</strong>
                {cleanAuthor && <span className="lyrics-modal-author"> — {cleanAuthor}</span>}
              </div>
              <button
                type="button"
                className="iconbtn iconbtn-sm"
                onClick={handleClose}
                aria-label="Close lyrics"
                title="Close"
              >
                ×
              </button>
            </header>
            <div className="lyrics-modal-body">
              {loading && <p className="lyrics-status">Loading…</p>}
              {!loading && error && (
                <p className="lyrics-status lyrics-status-error">
                  Couldn’t fetch lyrics: {error}
                </p>
              )}
              {!loading && !error && result && result.found && result.instrumental && (
                <p className="lyrics-status">Instrumental — no lyrics.</p>
              )}
              {!loading && !error && result && result.found && !result.instrumental && result.plainLyrics && (
                <pre className="lyrics-text">{result.plainLyrics}</pre>
              )}
              {!loading && !error && result && !result.found && (
                <div className="lyrics-status lyrics-status-empty">
                  <p>Not found on LRCLIB.</p>
                  <p className="lyrics-status-hint">
                    Try the PraiseCharts link beside this button for chart and lyric resources.
                  </p>
                </div>
              )}
            </div>
            <footer className="lyrics-modal-footer">
              {result && (
                <>
                  <span className="lyrics-modal-source">
                    Source: LRCLIB
                    {result.fromCache ? ' (cached)' : ''}
                  </span>
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => void load(true)}
                    disabled={loading}
                  >
                    Re-check LRCLIB
                  </button>
                </>
              )}
            </footer>
          </div>
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 3: Add CSS for the modal and the icon button variant**

Open `src/index.css`. Find the section where `.iconbtn-spotify` / `.iconbtn-youtube` / `.iconbtn-chart` are defined (around line 2435–2449 per the existing layout). Append after the last `.iconbtn-*` rule:

```css
/* Lyrics icon button — used in the slot row's lookup-row and on
   rejected cards. Matches the .iconbtn-sm dimensions; hover treatment
   uses --accent so the row stays visually balanced with Spotify /
   YouTube / PraiseCharts icons. */
.iconbtn-lyrics:hover {
  color: var(--accent);
  border-color: var(--accent);
}

/* Labeled "Lyrics" chip — sits inline at the end of the chorus-snippet
   text on candidate / rejected cards, directly replacing the small
   `.chip-ai` badge that used to live there. Sized to match the base
   `.chip` family (pill, small font, tight padding) so the snippet line
   still reads as a single visual unit. NOT decorated with the AI
   gradient — LRCLIB lyrics aren't AI-generated, and per CLAUDE.md AI
   styling is reserved for "explicit AI moments" only. */
.lyrics-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.18rem 0.55rem;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  background: var(--bg);
  color: var(--muted);
  border: 1px solid var(--border);
  margin-left: 0.4rem;
  vertical-align: middle;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.lyrics-chip:hover,
.lyrics-chip:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
  outline: none;
}

/* Full-screen modal for the lyrics popup. Used by LyricsButton. */
.lyrics-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.lyrics-modal-card {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  width: min(640px, 100%);
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
}
.lyrics-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.lyrics-modal-title {
  font-size: 0.95rem;
  line-height: 1.3;
}
.lyrics-modal-author {
  color: var(--muted);
  font-weight: normal;
}
.lyrics-modal-body {
  padding: 16px;
  overflow-y: auto;
  flex: 1 1 auto;
}
.lyrics-text {
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 0.95rem;
  line-height: 1.5;
  margin: 0;
}
.lyrics-status {
  color: var(--muted);
  text-align: center;
  padding: 24px 0;
}
.lyrics-status-error {
  color: var(--danger, #c0392b);
}
.lyrics-status-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}
.lyrics-status-hint {
  color: var(--muted);
  font-size: 0.85rem;
  margin: 0;
}
.lyrics-modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  font-size: 0.85rem;
}
.lyrics-modal-source {
  color: var(--muted);
}
```

If `--accent` or `--danger` don't exist in the existing CSS variable palette, drop the `var(...)` reference and use a literal color, or pick an existing variable from the same file (`grep -n "^  --" src/index.css | head -20` to inspect).

- [ ] **Step 4: Build the SPA to catch any type/CSS errors**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/LyricsButton.tsx src/index.css
git commit -m "Add LyricsButton component and modal styles"
```

---

## Task 9: Swap the `chip chip-ai` badge for `LyricsButton` inside the snippet lines

Two card sites currently render an inline `<span className="chip chip-ai">` (sparkle + "AI" badge) at the end of a chorus-snippet line. Both are replaced **in-place** by `<LyricsButton variant="chip" />`. The snippet text, the curly-quote framing, the outer `chorus-snippet` / `rejected-snippet` div, and the `title="AI-sourced lyrics. May be inaccurate."` tooltip on that outer div all stay — the snippet line is still the AI's teaser of the lyrics; we're just upgrading the trailing badge into a button that reveals the full lyric on click.

**Files:**
- Modify: `src/components/PlanDetail.tsx`

- [ ] **Step 1: Locate the two `chip chip-ai` spans**

```bash
grep -n "chip chip-ai\|chorus-snippet\|rejected-snippet" src/components/PlanDetail.tsx | head -10
```

Expected output points to two `<span className="chip chip-ai">` blocks:
- Inside the rejected card's `<div className="rejected-snippet">` around line 695.
- Inside the active card's `<div className="chorus-snippet">` around line 946.

Each span has the shape:

```jsx
<span
  className="chip chip-ai"
  aria-label="AI-sourced lyrics. May be inaccurate."
>
  <Icon name="sparkle" size={10} />
  AI
</span>
```

- [ ] **Step 2: Add the import at the top of the file**

Near the other `./` component imports:

```typescript
import { LyricsButton } from './LyricsButton'
```

- [ ] **Step 3: Replace the active card's `chip chip-ai` span (around line 946) with `<LyricsButton variant="chip" />`**

In `src/components/PlanDetail.tsx`, the active card's `chorus-snippet` block currently looks like:

```jsx
{c.suggestion.chorusSnippet && (
  <div
    className="chorus-snippet"
    title="AI-sourced lyrics. May be inaccurate."
  >
    <span className="snippet-quote" aria-hidden>“</span>
    {c.suggestion.chorusSnippet}
    <span className="snippet-quote" aria-hidden>”</span>
    <span
      className="chip chip-ai"
      aria-label="AI-sourced lyrics. May be inaccurate."
    >
      <Icon name="sparkle" size={10} />
      AI
    </span>
  </div>
)}
```

Edit so the trailing `chip chip-ai` span becomes the lyrics button — every other line stays:

```jsx
{c.suggestion.chorusSnippet && (
  <div
    className="chorus-snippet"
    title="AI-sourced lyrics. May be inaccurate."
  >
    <span className="snippet-quote" aria-hidden>“</span>
    {c.suggestion.chorusSnippet}
    <span className="snippet-quote" aria-hidden>”</span>
    <LyricsButton
      variant="chip"
      title={c.song?.title ?? c.suggestion.title}
      author={c.song?.author ?? c.suggestion.author ?? null}
    />
  </div>
)}
```

The fallback chain `c.song?.title ?? c.suggestion.title` prefers the canonical PCO library title when the candidate is matched, falling back to the AI's proposed title for unmatched candidates — same shape as the existing `SongLookupLinks` callers.

- [ ] **Step 4: Replace the rejected card's `chip chip-ai` span (around line 695) with `<LyricsButton variant="chip" />`**

The rejected card's `rejected-snippet` block currently looks like:

```jsx
{c.suggestion.chorusSnippet && (
  <div
    className="rejected-snippet"
    title="AI-sourced lyrics. May be inaccurate."
  >
    “{c.suggestion.chorusSnippet}”
    <span
      className="chip chip-ai"
      aria-label="AI-sourced lyrics. May be inaccurate."
    >
      <Icon name="sparkle" size={10} />
      AI
    </span>
  </div>
)}
```

Edit so the trailing `chip chip-ai` span becomes the lyrics button — all other lines stay:

```jsx
{c.suggestion.chorusSnippet && (
  <div
    className="rejected-snippet"
    title="AI-sourced lyrics. May be inaccurate."
  >
    “{c.suggestion.chorusSnippet}”
    <LyricsButton
      variant="chip"
      title={c.song?.title ?? c.suggestion.title}
      author={c.song?.author ?? c.suggestion.author ?? null}
    />
  </div>
)}
```

- [ ] **Step 5: Build the SPA to catch any type or JSX errors**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 6: Run the dev server and smoke-test both card sites**

```bash
npm run dev
```

Open a plan that has at least one active candidate and ideally at least one rejected candidate. Verify:

- **Active card:** the chorus snippet line is **still visible** with its curly-quoted snippet text; the sparkle + "AI" badge at the end is gone, replaced by a small "Lyrics" pill at the end of the same line.
- **Rejected card:** same — snippet line still visible, "AI" badge replaced by the "Lyrics" pill at the end of the same line.
- **Pill size and rhythm:** the new chip sits at roughly the same baseline as the old `chip-ai` did; line height is unchanged.
- **Click behavior:** clicking the pill opens the modal centered, loading state → lyrics (or not-found panel).
- **Modal close:** click outside or press Escape — modal closes.
- **Cache hit:** click the same card's pill again after closing — the footer shows "Source: LRCLIB (cached)".
- **Not-found state:** find or temporarily test against an obscure candidate where LRCLIB has no match — the modal shows "Not found on LRCLIB" + a hint pointing to PraiseCharts (no Genius link).

Stop the dev server (single Ctrl-C, **wait** for "export complete").

- [ ] **Step 7: Commit**

```bash
git add src/components/PlanDetail.tsx
git commit -m "Replace AI badge in chorus snippets with lyrics button"
```

---

## Task 10: Wire `LyricsButton` into filled slot rows

Insert the button into the slot row's `item-actions` div, alongside `ArrangementKeyEditor` and `SongLookupLinks`. Use `variant="icon"` to match the existing `sm`-sized SongLookupLinks icons in this row.

**Files:**
- Modify: `src/components/PlanDetail.tsx`

- [ ] **Step 1: Locate the slot-row render block**

```bash
grep -n "item-actions\|lookup-row" src/components/PlanDetail.tsx | head -10
```

Expected: the `<div className="item-actions">` block around lines 448–463 with `ArrangementKeyEditor` and the conditional `<div className="lookup-row">` containing `SongLookupLinks`.

- [ ] **Step 2: Add the lyrics button to the existing `lookup-row` block**

```jsx
{filled && (it.songId || displayTitle) && (
  <div className="item-actions">
    <ArrangementKeyEditor /* existing props */ />
    {displayTitle && (
      <div className="lookup-row">
        <SongLookupLinks query={displayTitle} size="sm" />
        <LyricsButton
          variant="icon"
          title={it.songTitle ?? displayTitle}
          author={it.songAuthor}
        />
      </div>
    )}
  </div>
)}
```

Preserve the existing `ArrangementKeyEditor` props as they are — only add the new `<LyricsButton>` line and adjust formatting.

- [ ] **Step 3: Run the dev server and smoke-test the slot-row button**

```bash
npm run dev
```

Open a plan with at least one filled slot. Click the lyrics icon on the slot row. Verify:
- The button renders at `iconbtn-sm` size (visually matches the other `iconbtn-sm` icons in the row).
- Modal behavior identical to the candidate-card case.
- For an instrumental track (rare for worship, but try one if available): modal shows "Instrumental — no lyrics."
- Not-found state shows the PraiseCharts hint with no external link.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/components/PlanDetail.tsx
git commit -m "Add lyrics button to filled slot rows"
```

---

## Task 11: Final verification + PR

- [ ] **Step 1: Run the full lint + test suite**

```bash
npm run lint && npm test
```

Expected: both green. Per CLAUDE.md, `npm run deploy` gates on these — broken lint or tests block any deploy.

- [ ] **Step 2: Run the production build for both SPA and Functions**

```bash
npm run build && npm --prefix functions run build
```

Expected: both exit 0.

- [ ] **Step 3: Manual end-to-end checklist (against the local emulator)**

```bash
npm run dev
```

Run through:

- [ ] Active candidate cards **still show the AI chorus snippet line** with curly-quoted teaser text; the sparkle + "AI" badge at the end is gone, replaced by a "Lyrics" pill.
- [ ] Rejected candidate cards **still show the rejected-snippet line**; the AI badge is similarly replaced by the "Lyrics" pill.
- [ ] Pill height + baseline match what the AI badge occupied — the snippet line height is unchanged.
- [ ] Click the "Lyrics" pill on a candidate with a popular worship song (e.g. "Reckless Love"). Lyrics appear within ~1s on first click. Modal text is scrollable if long.
- [ ] Close modal (× button, click outside, Escape) — all three close it.
- [ ] Click the same candidate's lyrics pill again. Modal opens; footer says "Source: LRCLIB (cached)".
- [ ] Click "Re-check LRCLIB" in the footer. Footer flips to "Source: LRCLIB" (no cached tag) on next render.
- [ ] Click lyrics pill on an obscure / unmatched candidate where LRCLIB likely has no entry. Modal shows "Not found on LRCLIB" + a hint pointing to PraiseCharts. **Confirm there is no Genius link.**
- [ ] Click lyrics button on a filled slot row. Same modal behavior, button renders icon-only at `iconbtn-sm` size beside the SongLookupLinks icons.
- [ ] Open Firestore emulator UI (`http://localhost:4000/firestore`) and confirm the `lyrics/*` collection has documents being created.
- [ ] Stop the dev server (single Ctrl-C, **wait** for "export complete").

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin lyrics-popup
gh pr create --title "Lyrics popup with LRCLIB lookup and Firestore cache" --body "$(cat <<'EOF'
## Summary
- New `getLyrics` Cloud Function queries LRCLIB and caches the result in a shared Firestore `lyrics/{cacheKey}` collection (keyed by hash of normalized title+author)
- Adds a "Lyrics" button (small inline pill) **at the end of the chorus-snippet line** on active and rejected candidate cards, directly replacing the small `chip chip-ai` badge that used to sit there. The snippet teaser text and its tooltip stay; the badge becomes an interactive button to the full lyric.
- Adds the lyrics button on filled slot rows (icon-only at `sm` size) beside the existing SongLookupLinks icons
- Manual "Re-check LRCLIB" button in the modal lets the user invalidate a stale negative result
- When LRCLIB has no match, the modal points users to PraiseCharts (already reachable from the same actions row). No Genius API, no external fallback.

## Test plan
- [ ] `npm run lint && npm test` green
- [ ] Snippet line stays visible on both active and rejected candidate cards
- [ ] Sparkle + "AI" badge is gone from the end of the snippet line, replaced by a "Lyrics" pill
- [ ] Lyrics modal opens on all three sites (active candidate snippet, rejected card snippet, slot row)
- [ ] Cache hit on second click of the same song (footer shows "(cached)")
- [ ] Force-refresh button bypasses the cache
- [ ] Not-found state shows PraiseCharts hint, no Genius link
- [ ] Instrumental tracks render "Instrumental — no lyrics"
EOF
)"
```

- [ ] **Step 5: After PR merges, run post-merge cleanup**

```bash
git checkout main
git pull --ff-only
git branch -d lyrics-popup
git fetch --prune
```

---

## Self-Review Notes (pre-handoff)

Checked against the user's correction ("I only want to replace the little AI icon inside [the snippet]"):

- **Snippet stays.** The `chorus-snippet` and `rejected-snippet` divs are untouched — text, curly quotes, outer `title=` tooltip all preserved. Only the trailing `<span className="chip chip-ai">` is swapped for the lyrics button. See Task 9 steps 3 and 4 — the before/after JSX is shown side-by-side to make the surgical edit unambiguous.
- **Button on active candidate snippet:** Task 9, step 3. Uses `variant="chip"` — small labeled pill sized to the `.chip` family.
- **Button on rejected card snippet:** Task 9, step 4. Same `variant="chip"`.
- **Button on filled slot rows:** Task 10. Uses `variant="icon"` to match the `sm`-sized SongLookupLinks icons in the `lookup-row`.
- **Candidates without a `chorusSnippet`:** no lyrics button on the card (no snippet div to host it). User can still reach lyrics via PraiseCharts in the candidate row's `listen-actions`. Documented in Task 8's prose.
- **Modal popup (not popover) — needs space for long lyrics:** Task 8.
- **Cache after first fetch:** Tasks 3, 4 (server-side shared cache keyed by `(title, author)`).
- **LRCLIB only — no Genius fallback:** Tasks 2, 4, 5. The not-found state in the modal (Task 8) directs the user to PraiseCharts.
- **Manual refresh escape hatch for negative results:** Task 4 (`forceRefresh`) + Task 8 (footer "Re-check LRCLIB" button).
- **AI styling is not applied to the lyrics chip** — lyrics from LRCLIB are not AI-generated, so the sparkle/gradient treatment of the prior `chip-ai` would be misleading. The new `.lyrics-chip` matches the base `.chip` dimensions but uses a neutral border + `--accent` hover, not the AI gradient.

Files referenced consistently: `getLyrics` callable name matches across `functions/src/index.ts`, `src/lib/api.ts`, and the component. The orchestrator's `GetLyricsResult` shape matches the SPA's `LyricsResult` interface. The `variant` prop values (`'chip' | 'icon'`) are consistent across all three call sites (Task 9 step 3, Task 9 step 4, Task 10 step 2).

No placeholders. Every step has runnable commands and complete code. TDD discipline preserved on the Functions side (test → fail → impl → pass → commit). The SPA component skips unit tests per CLAUDE.md's "test the seam, not the rendering" rule; Task 9/10 use manual smoke-testing in the dev server as the verification gate, with explicit checks that the snippet line is still visible and the chip badge is swapped for the lyrics pill.
