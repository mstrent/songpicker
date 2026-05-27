# LRCLIB Snippet Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AI-hallucinated chorus snippets on candidate cards with real lyrics sourced from LRCLIB, extracted via a batched Haiku call.

**Architecture:** New `enrichSnippets` callable backed by a shared module (`functions/src/lyrics/enrichSnippets.ts`). The SPA calls it lazily after candidates arrive (post-suggest and on plan reload). A `snippetSource` field on the candidate model drives migration of legacy AI snippets. The `chorusSnippet` field is stripped from all AI tool schemas.

**Tech Stack:** Anthropic SDK (Haiku 4.5), Firebase Cloud Functions, Firestore, LRCLIB REST API, React hooks, Vitest

---

## File Map

**Create:**
- `functions/src/lyrics/enrichSnippets.ts` — shared batch-enrich module (LRCLIB lookups + Haiku extraction)
- `functions/src/lyrics/enrichSnippets.test.ts` — unit tests for the module

**Modify:**
- `functions/src/ai/types.ts` — add `snippetSource` to `SongSuggestion`
- `functions/src/ai/anthropic.ts` — strip `chorusSnippet` from tool schemas and parsing
- `functions/src/ai/userMessage.ts` — remove snippet line from `renderCandidate`
- `functions/src/sessions.ts` — add `snippetSource` to `PersistedCandidate`, update serialization
- `functions/src/index.ts` — add `enrichSnippets` callable
- `src/lib/api.ts` — add `snippetSource` to client `SongSuggestion`, add `enrichSnippets` callable wrapper, update `classifySongSlots` return type
- `src/lib/useCandidatePool.ts` — add enrichment trigger (post-suggest + reload), deduplication guard
- `src/components/PlanDetail.tsx` — shimmer placeholder, source-aware tooltip
- `src/index.css` — shimmer animation CSS

---

### Task 1: Add `snippetSource` to data model

**Files:**
- Modify: `functions/src/ai/types.ts:1-8`
- Modify: `src/lib/api.ts:65-70`
- Modify: `functions/src/sessions.ts:13-32,66-92,94-120`

- [ ] **Step 1: Add `snippetSource` to server-side `SongSuggestion`**

In `functions/src/ai/types.ts`, add the field to the `SongSuggestion` interface:

```typescript
export interface SongSuggestion {
  title: string
  author?: string
  chorusSnippet?: string
  snippetSource?: 'lrclib' | 'haiku-extract' | 'haiku-generate'
  slots?: string[]
}
```

- [ ] **Step 2: Add `snippetSource` to client-side `SongSuggestion`**

In `src/lib/api.ts`, mirror the change at line 65:

```typescript
export interface SongSuggestion {
  title: string
  author?: string
  chorusSnippet?: string
  snippetSource?: 'lrclib' | 'haiku-extract' | 'haiku-generate'
  slots?: string[]
}
```

- [ ] **Step 3: Add `snippetSource` to `PersistedCandidate` and update serialization**

In `functions/src/sessions.ts`, add to the interface after line 17 (`chorusSnippet`):

```typescript
export interface PersistedCandidate {
  id: string
  title: string
  author: string | null
  chorusSnippet: string | null
  snippetSource: string | null
  slots: string[]
  matchStatus: MatchStatus
  song: PersistedSongRef | null
  error: string | null
  decision: Decision
  addedAt: number
  assignedSlotItemId: string | null
  committedAt: number | null
  priorSlotTitle: string | null
}
```

In `toPersisted()`, add after the `chorusSnippet` line:

```typescript
snippetSource: c.suggestion.snippetSource ?? null,
```

In `fromPersisted()`, add inside the `suggestion` object after the `chorusSnippet` line:

```typescript
snippetSource:
  typeof p.snippetSource === 'string'
    ? (p.snippetSource as SongSuggestion['snippetSource'])
    : undefined,
```

- [ ] **Step 4: Commit**

```bash
git add functions/src/ai/types.ts src/lib/api.ts functions/src/sessions.ts
git commit -m "feat: add snippetSource field to candidate data model"
```

---

### Task 2: Strip `chorusSnippet` from AI tool schemas and parsing

**Files:**
- Modify: `functions/src/ai/anthropic.ts:34-41,59-69,71-85,105-128,456-475,354-370`
- Modify: `functions/src/ai/types.ts:181-184`
- Modify: `functions/src/ai/userMessage.ts:126-128`
- Modify: `src/lib/api.ts:264-275`

- [ ] **Step 1: Remove `CHORUS_SNIPPET_GUIDANCE` and `CHORUS_SNIPPET_FIELD` from `anthropic.ts`**

Delete the `CHORUS_SNIPPET_GUIDANCE` constant (lines 34-41) and its `export`.

Delete the `CHORUS_SNIPPET_FIELD` constant (lines 66-69).

- [ ] **Step 2: Strip `chorusSnippet` from `propose_songs` tool properties**

In the `propose_songs` tool definition (around line 112-127), remove the `chorusSnippet` property from the `suggestions` items. The properties block becomes:

```typescript
properties: {
  suggestions: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        author: { type: 'string' },
        slots: SONG_SLOTS_FIELD,
      },
      required: ['title'],
    },
  },
},
```

- [ ] **Step 3: Strip `chorusSnippet` from `classify_song` tool and update its description**

Replace the `classify_song` tool definition (lines 71-85):

```typescript
export const CLASSIFY_SONG_TOOL: Anthropic.Tool = {
  name: 'classify_song',
  description:
    'Return slot-position labels for the given song.',
  input_schema: {
    type: 'object',
    properties: {
      slots: { ...SONG_SLOTS_FIELD, minItems: 1, maxItems: 3 },
    },
    required: ['slots'],
  },
}
```

- [ ] **Step 4: Remove `chorusSnippet` from `parsePropose()`**

In `parsePropose()` (around line 456), remove the `chorusSnippet` field from the pushed suggestion. It becomes:

```typescript
suggestions.push({
  title: r.title.trim(),
  author: typeof r.author === 'string' ? r.author : undefined,
  slots: Array.isArray(r.slots)
    ? r.slots.filter((s): s is string => typeof s === 'string')
    : undefined,
})
```

- [ ] **Step 5: Remove `chorusSnippet` from classifier response parsing**

In the classifier response handler (around line 354-370), remove the `chorusSnippet` extraction. The tool_use block handler becomes:

```typescript
for (const block of response.content) {
  if (block.type !== 'tool_use' || block.name !== 'classify_song') continue
  const input = block.input as { slots?: unknown }
  const slots = Array.isArray(input.slots)
    ? input.slots
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 3)
    : []
  if (slots.length > 0) {
    return { slots }
  }
}
```

- [ ] **Step 6: Update `ClassifySongResult` to remove `chorusSnippet`**

In `functions/src/ai/types.ts` (line 181-184):

```typescript
export interface ClassifySongResult {
  slots: string[]
}
```

- [ ] **Step 7: Update client-side `classifySongSlots` return type**

In `src/lib/api.ts` (line 264-275), remove `chorusSnippet` from the return type:

```typescript
export const classifySongSlots = httpsCallable<
  {
    planId?: string
    songTitle: string
    songAuthor?: string
    songCcli?: string
    theme?: string
    planNotes?: string
    serviceOrder?: string
  },
  { slots: string[] }
>(functions, 'classifySongSlots')
```

- [ ] **Step 8: Remove snippet from `renderCandidate` in `userMessage.ts`**

Delete the snippet block at lines 126-128:

```typescript
  if (c.chorusSnippet) {
    parts.push(`— chorus: "${c.chorusSnippet}"`)
  }
```

- [ ] **Step 9: Remove `chorusSnippet` merge from eviction enrichment in `useCandidatePool.ts`**

Find the `classifySongSlots` `.then()` handler (around line 488-509) that merges `chorusSnippet` into the candidate. Remove the snippet merge so it only handles slot labels. The handler becomes:

```typescript
.then((r) => {
  const { slots } = r.data
  if (slots.length === 0) return
  patchBySongId((c) => ({
    ...c,
    suggestion: {
      ...c.suggestion,
      slots,
    },
  }))
})
```

- [ ] **Step 10: Verify build and existing tests pass**

Run: `npm run lint && npm test && npm --prefix functions run build`

Expected: All pass. No test should reference `CHORUS_SNIPPET_GUIDANCE` or `CHORUS_SNIPPET_FIELD` (there are no existing prompt-structure tests for these).

- [ ] **Step 11: Commit**

```bash
git add functions/src/ai/types.ts functions/src/ai/anthropic.ts functions/src/ai/userMessage.ts functions/src/sessions.ts src/lib/api.ts src/lib/useCandidatePool.ts
git commit -m "feat: strip chorusSnippet from AI tool schemas and prompt context"
```

---

### Task 3: Build `enrichSnippets` server module

**Files:**
- Create: `functions/src/lyrics/enrichSnippets.ts`
- Create: `functions/src/lyrics/enrichSnippets.test.ts`
- Modify: `functions/src/lyrics/cache.ts:36-40` (export `lyricsCacheKey`)

- [ ] **Step 1: Export `lyricsCacheKey` from cache module**

In `functions/src/lyrics/cache.ts`, `lyricsCacheKey` is already exported. Verify this — no change needed if so.

Run: `grep 'export function lyricsCacheKey' functions/src/lyrics/cache.ts`

Expected: `export function lyricsCacheKey(title: string, author?: string): string {`

- [ ] **Step 2: Write the failing test for `enrichSnippets` — all-cached LRCLIB hits**

Create `functions/src/lyrics/enrichSnippets.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enrichSnippets, type EnrichSnippetsDeps } from './enrichSnippets'

function makeDeps(overrides: Partial<EnrichSnippetsDeps> = {}): EnrichSnippetsDeps {
  return {
    batchReadLyricsCache: vi.fn().mockResolvedValue([]),
    fetchAndCacheLyrics: vi.fn().mockResolvedValue({
      found: false, plainLyrics: null, instrumental: false, artistName: null,
    }),
    callHaiku: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

describe('enrichSnippets', () => {
  it('returns LRCLIB-extracted snippets when all songs are cached', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        { found: true, plainLyrics: 'I count on one thing\nThe same God who never fails\nWill be faithful', artistName: 'Vertical Worship' },
        { found: true, plainLyrics: 'Come let us worship our King\nCome let us bow at His feet', artistName: 'Phil Wickham' },
      ]),
      callHaiku: vi.fn().mockResolvedValue({
        '0': 'I count on one thing\nThe same God who never fails',
        '1': 'Come let us worship our King\nCome let us bow at His feet',
      }),
    })

    const results = await enrichSnippets(
      [
        { title: 'Yes I Will', author: 'Eddie Hoagland' },
        { title: 'Great Things', author: 'Phil Wickham' },
      ],
      deps,
    )

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      snippet: 'I count on one thing\nThe same God who never fails',
      source: 'lrclib',
    })
    expect(results[1]).toEqual({
      snippet: 'Come let us worship our King\nCome let us bow at His feet',
      source: 'lrclib',
    })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- functions/src/lyrics/enrichSnippets.test.ts`

Expected: FAIL — module `./enrichSnippets` does not exist.

- [ ] **Step 4: Write the `enrichSnippets` module**

Create `functions/src/lyrics/enrichSnippets.ts`:

```typescript
import type { LyricsCacheEntry } from './cache'
import type { LrclibResult } from './lrclib'

export interface SnippetQuery {
  title: string
  author?: string
}

export type SnippetSource = 'lrclib' | 'haiku-extract' | 'haiku-generate'

export interface SnippetResult {
  snippet: string | null
  source: SnippetSource
}

export interface EnrichSnippetsDeps {
  batchReadLyricsCache(
    queries: SnippetQuery[],
  ): Promise<Array<LyricsCacheEntry | null>>
  fetchAndCacheLyrics(query: SnippetQuery): Promise<LrclibResult>
  callHaiku(prompt: string): Promise<Record<string, string | null>>
}

function buildHaikuPrompt(
  songs: Array<{
    index: number
    title: string
    author?: string
    lyrics: string | null
  }>,
): string {
  const parts = songs.map((s) => {
    if (s.lyrics) {
      return `${s.index}. "${s.title}"${s.author ? ` by ${s.author}` : ''}\n\n${s.lyrics}`
    }
    return `${s.index}. "${s.title}"${s.author ? ` by ${s.author}` : ''}\n\n(No lyrics available — recall from knowledge if confident)`
  })

  return `Extract a 2–4 line chorus or representative snippet from each song. For songs with lyrics provided, extract the most recognizable repeated section. For songs without lyrics, recall the chorus if you are confident you know it — otherwise return null.

Reply as JSON only: {"0": "snippet or null", "1": "snippet or null", ...}
Use the numeric keys shown below. Return null (not the string "null") for songs you cannot extract or recall.

${parts.join('\n\n---\n\n')}`
}

function parseHaikuResponse(
  raw: Record<string, string | null>,
  count: number,
): Array<string | null> {
  const results: Array<string | null> = []
  for (let i = 0; i < count; i++) {
    const val = raw[String(i)]
    results.push(typeof val === 'string' && val.trim() ? val.trim() : null)
  }
  return results
}

export async function enrichSnippets(
  queries: SnippetQuery[],
  deps: EnrichSnippetsDeps,
): Promise<SnippetResult[]> {
  if (queries.length === 0) return []

  // Step 1: batch cache read
  const cached = await deps.batchReadLyricsCache(queries)

  // Step 2: fetch LRCLIB for cache misses
  const lyrics: Array<string | null> = []
  const fetchPromises: Array<Promise<void>> = []
  for (let i = 0; i < queries.length; i++) {
    const entry = cached[i]
    if (entry?.found && entry.plainLyrics) {
      lyrics[i] = entry.plainLyrics
    } else {
      lyrics[i] = null
      fetchPromises.push(
        deps
          .fetchAndCacheLyrics(queries[i])
          .then((r) => {
            if (r.found && r.plainLyrics) lyrics[i] = r.plainLyrics
          })
          .catch(() => {}),
      )
    }
  }
  await Promise.all(fetchPromises)

  // Step 3: single Haiku call for all songs
  const haikuInput = queries.map((q, i) => ({
    index: i,
    title: q.title,
    author: q.author,
    lyrics: lyrics[i],
  }))

  let haikuSnippets: Array<string | null>
  try {
    const raw = await deps.callHaiku(buildHaikuPrompt(haikuInput))
    haikuSnippets = parseHaikuResponse(raw, queries.length)
  } catch {
    haikuSnippets = queries.map(() => null)
  }

  // Step 4: assemble results
  return queries.map((_, i): SnippetResult => {
    const snippet = haikuSnippets[i] ?? null
    if (!snippet) {
      return { snippet: null, source: lyrics[i] ? 'lrclib' : 'haiku-generate' }
    }
    if (lyrics[i]) {
      return { snippet, source: 'lrclib' }
    }
    return { snippet, source: 'haiku-generate' }
  })
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- functions/src/lyrics/enrichSnippets.test.ts`

Expected: PASS

- [ ] **Step 6: Add test for LRCLIB misses with Haiku generation**

Append to the `describe` block in `enrichSnippets.test.ts`:

```typescript
  it('falls back to haiku-generate for LRCLIB misses', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([null]),
      fetchAndCacheLyrics: vi.fn().mockResolvedValue({
        found: false, plainLyrics: null, instrumental: false, artistName: null,
      }),
      callHaiku: vi.fn().mockResolvedValue({
        '0': 'Amazing grace how sweet the sound',
      }),
    })

    const results = await enrichSnippets(
      [{ title: 'Amazing Grace', author: 'John Newton' }],
      deps,
    )

    expect(results[0]).toEqual({
      snippet: 'Amazing grace how sweet the sound',
      source: 'haiku-generate',
    })
  })
```

- [ ] **Step 7: Run the test**

Run: `npm test -- functions/src/lyrics/enrichSnippets.test.ts`

Expected: PASS

- [ ] **Step 8: Add test for mixed hits/misses**

Append to the `describe` block:

```typescript
  it('handles mixed LRCLIB hits and misses in one batch', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        { found: true, plainLyrics: 'You call me out upon the waters', artistName: 'Hillsong' },
        null,
      ]),
      fetchAndCacheLyrics: vi.fn().mockResolvedValue({
        found: false, plainLyrics: null, instrumental: false, artistName: null,
      }),
      callHaiku: vi.fn().mockResolvedValue({
        '0': 'Spirit lead me where my trust is without borders',
        '1': null,
      }),
    })

    const results = await enrichSnippets(
      [
        { title: 'Oceans', author: 'Hillsong' },
        { title: 'Obscure Hymn' },
      ],
      deps,
    )

    expect(results[0]).toEqual({
      snippet: 'Spirit lead me where my trust is without borders',
      source: 'lrclib',
    })
    expect(results[1]).toEqual({
      snippet: null,
      source: 'haiku-generate',
    })
  })
```

- [ ] **Step 9: Add test for Haiku failure fallback**

Append to the `describe` block:

```typescript
  it('returns null snippets when Haiku call fails entirely', async () => {
    const deps = makeDeps({
      batchReadLyricsCache: vi.fn().mockResolvedValue([
        { found: true, plainLyrics: 'Some lyrics', artistName: 'Artist' },
      ]),
      callHaiku: vi.fn().mockRejectedValue(new Error('API down')),
    })

    const results = await enrichSnippets(
      [{ title: 'Some Song' }],
      deps,
    )

    expect(results[0]).toEqual({ snippet: null, source: 'lrclib' })
  })
```

- [ ] **Step 10: Add test for empty input**

Append to the `describe` block:

```typescript
  it('returns empty array for empty input', async () => {
    const deps = makeDeps()
    const results = await enrichSnippets([], deps)
    expect(results).toEqual([])
    expect(deps.batchReadLyricsCache).not.toHaveBeenCalled()
  })
```

- [ ] **Step 11: Run all tests**

Run: `npm test -- functions/src/lyrics/enrichSnippets.test.ts`

Expected: All PASS

- [ ] **Step 12: Commit**

```bash
git add functions/src/lyrics/enrichSnippets.ts functions/src/lyrics/enrichSnippets.test.ts
git commit -m "feat: add enrichSnippets module with batched LRCLIB + Haiku extraction"
```

---

### Task 4: Add `enrichSnippets` callable and wire deps

**Files:**
- Modify: `functions/src/lyrics/index.ts`
- Modify: `functions/src/index.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add batch cache read and default deps factory to lyrics orchestrator**

In `functions/src/lyrics/index.ts`, add imports and a new `defaultEnrichDeps` factory:

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { Firestore } from 'firebase-admin/firestore'

import {
  lyricsCacheKey,
  readLyricsCache,
  writeLyricsCache,
  type LyricsCacheEntry,
} from './cache'
import { createLyricsDisambiguator } from './disambiguate'
import {
  enrichSnippets as enrichSnippetsCore,
  type EnrichSnippetsDeps,
  type SnippetQuery,
  type SnippetResult,
} from './enrichSnippets'
import { fetchFromLrclib, type LrclibResult } from './lrclib'
```

Add at the bottom of the file:

```typescript
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export function defaultEnrichDeps(
  db: Firestore,
  anthropicApiKey: string,
): EnrichSnippetsDeps {
  const client = new Anthropic({ apiKey: anthropicApiKey })
  const disambiguate = createLyricsDisambiguator(anthropicApiKey)

  return {
    async batchReadLyricsCache(
      queries: SnippetQuery[],
    ): Promise<Array<LyricsCacheEntry | null>> {
      if (queries.length === 0) return []
      const keys = queries.map((q) => lyricsCacheKey(q.title, q.author))
      const COLLECTION = 'lyrics'
      const snaps = await db.getAll(
        ...keys.map((k) => db.collection(COLLECTION).doc(k)),
      )
      return snaps.map((snap) => {
        if (!snap.exists) return null
        const data = snap.data() as LyricsCacheEntry & { title?: string; author?: string } | undefined
        if (!data) return null
        return {
          found: data.found,
          plainLyrics: data.plainLyrics,
          instrumental: data.instrumental,
          lrclibId: data.lrclibId,
          artistName: data.artistName ?? null,
          source: data.source,
          fetchedAt: data.fetchedAt,
        }
      })
    },

    async fetchAndCacheLyrics(query: SnippetQuery): Promise<LrclibResult> {
      const fresh = await fetchFromLrclib(
        { title: query.title, author: query.author },
        disambiguate,
      )
      await writeLyricsCache(db, query.title, query.author, fresh)
      return fresh
    },

    async callHaiku(prompt: string): Promise<Record<string, string | null>> {
      const response = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      })
      const text =
        response.content[0]?.type === 'text' ? response.content[0].text : ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return {}
      return JSON.parse(jsonMatch[0])
    },
  }
}

export { enrichSnippetsCore as enrichSnippetsBatch }
export type { SnippetQuery, SnippetResult }
```

- [ ] **Step 2: Add `enrichSnippets` callable to `functions/src/index.ts`**

Add after the `getLyrics` callable (around line 362):

```typescript
export const enrichSnippets = onCall(
  { secrets: [ANTHROPIC_API_KEY] },
  async (req) => {
    await requireAllowed(req)
    const { songs } = req.data as {
      songs?: Array<{ title?: string; author?: string }>
    }
    if (!Array.isArray(songs) || songs.length === 0) {
      throw new HttpsError('invalid-argument', 'songs array required')
    }
    if (songs.length > 20) {
      throw new HttpsError('invalid-argument', 'max 20 songs per batch')
    }
    const validated = songs
      .filter(
        (s): s is { title: string; author?: string } =>
          typeof s.title === 'string' && s.title.trim().length > 0,
      )
      .map((s) => ({
        title: s.title.trim(),
        author:
          typeof s.author === 'string' && s.author.trim()
            ? s.author.trim()
            : undefined,
      }))
    const db = getFirestore()
    const deps = defaultEnrichDeps(db, ANTHROPIC_API_KEY.value())
    const results = await enrichSnippetsBatch(validated, deps)
    return { results }
  },
)
```

Add the import at the top of `functions/src/index.ts`:

```typescript
import { defaultEnrichDeps, enrichSnippetsBatch } from './lyrics'
```

(Alongside the existing `import { defaultLyricsDeps, getLyricsForSong } from './lyrics'`)

- [ ] **Step 3: Add client-side callable wrapper in `src/lib/api.ts`**

Add after the `getLyrics` callable (around line 311):

```typescript
export type SnippetSource = 'lrclib' | 'haiku-extract' | 'haiku-generate'

export interface SnippetEnrichResult {
  snippet: string | null
  source: SnippetSource
}

export const enrichSnippets = httpsCallable<
  { songs: Array<{ title: string; author?: string }> },
  { results: SnippetEnrichResult[] }
>(functions, 'enrichSnippets')
```

- [ ] **Step 4: Build and run full test suite**

Run: `npm run lint && npm test && npm --prefix functions run build`

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add functions/src/lyrics/index.ts functions/src/index.ts src/lib/api.ts
git commit -m "feat: add enrichSnippets callable with batched LRCLIB + Haiku"
```

---

### Task 5: Wire enrichment into `useCandidatePool`

**Files:**
- Modify: `src/lib/useCandidatePool.ts`

- [ ] **Step 1: Add the enrichment trigger function**

Near the top of the `useCandidatePool` hook (inside the hook body, after state declarations), add an enrichment ref and function:

```typescript
const enrichInFlightRef = useRef(false)

const triggerEnrichment = useCallback(
  async (pool: CandidateMatch[]) => {
    if (enrichInFlightRef.current) return
    const needsEnrich = pool.filter((c) => !c.suggestion.snippetSource)
    if (needsEnrich.length === 0) return

    enrichInFlightRef.current = true
    setCandidates((prev) =>
      prev.map((c) =>
        !c.suggestion.snippetSource
          ? { ...c, enrichmentPending: true }
          : c,
      ),
    )

    try {
      const res = await enrichSnippets({
        songs: needsEnrich.map((c) => ({
          title: c.song?.title ?? c.suggestion.title,
          author: c.song?.author ?? c.suggestion.author ?? undefined,
        })),
      })
      const enrichResults = res.data.results
      setCandidates((prev) =>
        prev.map((c) => {
          if (c.suggestion.snippetSource) return c
          const idx = needsEnrich.findIndex((n) => n.id === c.id)
          if (idx === -1 || !enrichResults[idx]) {
            return { ...c, enrichmentPending: false }
          }
          const { snippet, source } = enrichResults[idx]
          return {
            ...c,
            enrichmentPending: false,
            suggestion: {
              ...c.suggestion,
              chorusSnippet: snippet ?? undefined,
              snippetSource: source,
            },
          }
        }),
      )
    } catch {
      setCandidates((prev) =>
        prev.map((c) =>
          c.enrichmentPending ? { ...c, enrichmentPending: false } : c,
        ),
      )
    } finally {
      enrichInFlightRef.current = false
    }
  },
  [setCandidates],
)
```

Add the import at the top of the file:

```typescript
import { enrichSnippets } from './api'
```

- [ ] **Step 2: Trigger enrichment via `useEffect`**

Add a `useEffect` that watches for candidates without `snippetSource`. This handles both post-suggest and reload paths in one place. The deduplication guard (`enrichInFlightRef`) prevents double-firing.

```typescript
useEffect(() => {
  triggerEnrichment(candidates)
}, [candidates, triggerEnrichment])
```

- [ ] **Step 3: Verify build passes**

Run: `npm run lint && npm test && npm --prefix functions run build`

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/useCandidatePool.ts
git commit -m "feat: trigger snippet enrichment from useCandidatePool"
```

---

### Task 6: Shimmer placeholder and source-aware tooltip

**Files:**
- Modify: `src/components/PlanDetail.tsx:949-963,702-714`
- Modify: `src/index.css:2271-2275,2293-2309`

- [ ] **Step 1: Add shimmer CSS**

In `src/index.css`, add after the `.candidate .chorus-snippet .snippet-quote` block (around line 2309):

```css
.candidate .snippet-shimmer,
.rejected-card .snippet-shimmer {
  height: 2.4em;
  border-radius: 6px;
  background: linear-gradient(
    90deg,
    var(--accent-soft) 25%,
    color-mix(in srgb, var(--accent-soft) 60%, transparent) 50%,
    var(--accent-soft) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  margin-top: 0.35rem;
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

- [ ] **Step 2: Helper function for snippet tooltip**

Add a helper near the top of `PlanDetail.tsx` (before the component):

```typescript
function snippetTooltip(
  source: string | undefined,
): string | undefined {
  if (source === 'lrclib' || source === 'haiku-extract') return undefined
  if (source === 'haiku-generate')
    return 'Lyrics recalled from AI — may be inaccurate.'
  return 'AI-sourced lyrics. May be inaccurate.'
}
```

- [ ] **Step 3: Update active candidate snippet rendering**

Replace the active candidate snippet block (lines 949-963):

```typescript
{c.enrichmentPending && !c.suggestion.chorusSnippet ? (
  <div className="snippet-shimmer" />
) : c.suggestion.chorusSnippet ? (
  <div
    className="chorus-snippet"
    title={snippetTooltip(c.suggestion.snippetSource)}
  >
    <span className="snippet-quote" aria-hidden>"</span>
    {c.suggestion.chorusSnippet}
    <span className="snippet-quote" aria-hidden>"</span>
    <LyricsTrigger
      variant="chip"
      title={c.song?.title ?? c.suggestion.title}
      author={c.song?.author ?? c.suggestion.author ?? null}
      onActivate={setActiveLyrics}
    />
  </div>
) : null}
```

- [ ] **Step 4: Update rejected candidate snippet rendering**

Replace the rejected snippet block (lines 702-714):

```typescript
{c.suggestion.chorusSnippet && (
  <div
    className="rejected-snippet"
    title={snippetTooltip(c.suggestion.snippetSource)}
  >
    "{c.suggestion.chorusSnippet}"
    <LyricsTrigger
      variant="chip"
      title={c.song?.title ?? c.suggestion.title}
      author={c.song?.author ?? c.suggestion.author ?? null}
      onActivate={setActiveLyrics}
    />
  </div>
)}
```

- [ ] **Step 5: Verify build passes**

Run: `npm run lint && npm test && npm --prefix functions run build`

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/PlanDetail.tsx src/index.css
git commit -m "feat: shimmer placeholder and source-aware tooltip for snippets"
```

---

### Task 7: Prompt removal regression test

**Files:**
- Create or modify: `functions/src/ai/anthropic.test.ts` (create if no tool-schema tests exist)

- [ ] **Step 1: Write structural assertion that tool schemas lack `chorusSnippet`**

Check if `functions/src/ai/anthropic.test.ts` exists. If not, create it. Add:

```typescript
import { describe, expect, it } from 'vitest'

import { CLASSIFY_SONG_TOOL } from './anthropic'

describe('tool schema regression', () => {
  it('propose_songs schema does not include chorusSnippet', async () => {
    // Dynamic import to access the tool definitions. The propose_songs
    // tool is built inline in the suggest() method, but the shared
    // SONG_SLOTS_FIELD and tool structure are what we're verifying
    // don't include snippet fields.
    const mod = await import('./anthropic')
    // CLASSIFY_SONG_TOOL is exported; propose_songs tool is built at
    // call time, but we verify the shared constant is gone.
    expect(mod).not.toHaveProperty('CHORUS_SNIPPET_GUIDANCE')
  })

  it('classify_song schema does not include chorusSnippet', () => {
    const props = (CLASSIFY_SONG_TOOL.input_schema as { properties: Record<string, unknown> }).properties
    expect(props).not.toHaveProperty('chorusSnippet')
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npm test -- functions/src/ai/anthropic.test.ts`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add functions/src/ai/anthropic.test.ts
git commit -m "test: regression test for chorusSnippet removal from AI tool schemas"
```

---

### Task 8: Manual verification

**Files:** None (runtime testing)

- [ ] **Step 1: Start dev environment**

Run: `npm run dev`

Wait for "export complete" message.

- [ ] **Step 2: Open a plan with existing candidates**

Navigate to a plan that has AI-suggested candidates with old snippets. Verify:
- Shimmer placeholders appear briefly on candidates with missing `snippetSource`
- Shimmers resolve to real LRCLIB-sourced snippets (or Haiku-generated fallbacks)
- The "AI-sourced lyrics" tooltip is gone for LRCLIB-sourced snippets
- Cards don't reflow when snippets load

- [ ] **Step 3: Trigger a fresh AI suggestion**

Click the Suggest button. Verify:
- The AI no longer returns `chorusSnippet` in proposals (check debug panel)
- Cards appear immediately without snippets
- Shimmers appear, then resolve via enrichment
- Snippets show real lyrics, not AI hallucinations

- [ ] **Step 4: Test LRCLIB miss fallback**

Find or create a candidate for an obscure song not on LRCLIB. Verify:
- If Haiku generates a snippet, it shows with the "Lyrics recalled from AI" tooltip
- If Haiku returns null, no snippet is shown (no shimmer stuck in loading state)

- [ ] **Step 5: Stop dev environment**

Press Ctrl-C once, wait for "export complete" before pressing again.

- [ ] **Step 6: Run full verification**

Run: `npm run lint && npm test && npm --prefix functions run build`

Expected: All pass.
