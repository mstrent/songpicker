# LRCLIB Snippet Enrichment

Replace AI-hallucinated chorus snippets on candidate cards with real
lyrics sourced from LRCLIB, extracted via a batched Haiku call. Lazy
client-side enrichment: cards render immediately with a shimmer
placeholder, snippets fill in asynchronously.

## Motivation

The `propose_songs` tool currently asks Sonnet to recall a chorus
snippet from training data. This is unreliable — the AI fabricates
plausible-sounding lyrics, blends lyrics from same-titled songs, or
confidently returns wrong text. The `CHORUS_SNIPPET_GUIDANCE` prompt
text mitigates but doesn't solve the problem, and costs ~200 tokens
per turn. LRCLIB already provides accurate full lyrics for the popover;
we can extract short snippets from the same data.

## Architecture: Approach C (shared module + callable)

A new `enrichSnippets` callable backed by a shared internal module.
The SPA calls it after receiving candidates and on plan reload for
stale data. A `snippetSource` flag on the candidate model drives lazy
migration of legacy AI snippets.

This keeps the door open to inline the shared module in the
`suggestSongs` stream later if the second round-trip ever feels slow,
without any of that complexity now.

## Data model changes

### Add `snippetSource` to the candidate model

Add `snippetSource?: 'lrclib' | 'haiku-extract' | 'haiku-generate'`
to:

- `SongSuggestion` in `functions/src/ai/types.ts` and `src/lib/api.ts`
- `PersistedCandidate` in `functions/src/sessions.ts`
- `CandidateMatch.suggestion` (inherits from `SongSuggestion`)

Legacy candidates and fresh `propose_songs` results have
`snippetSource` absent. The SPA treats absent as "needs enrichment."

Serialization in `toPersisted` / `fromPersisted`: persist as
`snippetSource: string | null`, read back with fallback to `undefined`.

### Remove `chorusSnippet` from AI tool schemas

Strip from the AI's responsibility entirely:

- Remove `CHORUS_SNIPPET_FIELD` from `propose_songs` and
  `classify_song` tool definitions in `anthropic.ts`.
- Remove `CHORUS_SNIPPET_GUIDANCE` constant.
- Remove snippet parsing in `parsePropose()` and the classifier
  response handler.
- Remove the snippet line from `renderCandidates` in
  `userMessage.ts` — the AI no longer sees or produces snippets.

Token savings: ~200 tokens of guidance text per turn, plus schema
overhead and per-candidate snippet output.

### Keep `chorusSnippet` on the candidate model

The field stays — it still holds the snippet text. Only the source
changes.

## Server-side: `enrichSnippets` module + callable

### Shared module: `functions/src/lyrics/enrichSnippets.ts`

**Input:** `Array<{ title: string; author?: string }>` + Anthropic API
key.

**Steps:**

1. **Batch LRCLIB lookup.** Compute cache keys for all songs.
   Batch-read from Firestore via `where('__name__', 'in', keys)`.
   (Firestore caps at 30 per `in` query; candidate batches are
   ~10 max.) Cache misses fan out to `fetchFromLrclib` in parallel,
   bounded by existing concurrency controls. Write fresh results back
   to cache.

2. **Partition.** Split songs into "has lyrics" (LRCLIB hit) and
   "no lyrics" (LRCLIB miss).

3. **Single Haiku call.** One `messages.create` with all songs in
   the batch. For LRCLIB hits, the prompt includes the full lyrics
   and asks Haiku to extract 2-4 representative chorus lines. For
   LRCLIB misses, just title + author — Haiku generates a snippet
   if confident, returns null if not. Response as JSON:
   `{"0": "snippet or null", "1": "snippet or null", ...}`.

4. **Parse + return.** Parse Haiku's JSON response. If Haiku returns
   malformed JSON or omits an index, treat that song as
   `snippet: null`. Return array of
   `{ snippet: string | null; source: 'lrclib' | 'haiku-extract' | 'haiku-generate' }`
   aligned to input indices. If the entire Haiku call fails, return
   `snippet: null` for all songs — the cards render without snippets
   rather than blocking.

### Callable: `enrichSnippets` in `functions/src/index.ts`

Thin wrapper — validates input array, calls the shared module,
returns results. Declares `secrets: [ANTHROPIC_API_KEY]`. Auth-gated
via `requireAllowed`.

**Cost:** One Firestore batch read + 0-N LRCLIB fetches (most cached)
+ one Haiku call (~3-4k input, ~200 output). Negligible.

## Client-side: enrichment flow in `useCandidatePool`

### Post-suggest enrichment

After `propose_songs` results are processed and candidates are added
to the pool, collect any candidates with absent `snippetSource` and
call `enrichSnippets` with their `{title, author}` pairs. When
results come back, patch each candidate's `chorusSnippet` and
`snippetSource`. Session auto-saves as usual.

### Plan-reload enrichment

When the session is restored from Firestore on plan load, scan for
candidates with missing `snippetSource` (legacy AI snippets). Queue
those for the same `enrichSnippets` call. Lazily migrates old data —
each plan only re-enriches once.

### Eviction enrichment

The current `classifySongSlots` flow mints a candidate on eviction
and enriches it with slot labels + snippet via a Sonnet call. After
stripping `chorusSnippet` from the classifier tool, the eviction
path creates the candidate with no snippet. The same
absent-`snippetSource` check picks it up for enrichment along with
any other pending candidates.

### Deduplication

If an enrichment call is already in-flight, don't fire another.
New candidates that arrive mid-flight get picked up on the next
trigger (next `propose_songs` batch or plan reload).

### `enrichmentPending` flag

`CandidateMatch` already has `enrichmentPending?: boolean`. Set it
true when a candidate is queued for enrichment, clear it when the
result lands. The rendering layer uses this for the shimmer
placeholder.

## Rendering changes

### Shimmer placeholder

When `enrichmentPending` is true and `chorusSnippet` is absent,
render a CSS-only shimmer placeholder matching the dimensions of a
typical 2-line snippet. No card reflow when the real text arrives.

### Source-aware disclaimer

Replace the blanket "AI-sourced lyrics. May be inaccurate." tooltip:

| `snippetSource`    | Tooltip                                |
|--------------------|----------------------------------------|
| `'lrclib'`         | None (real lyrics)                     |
| `'haiku-extract'`  | None (extracted from real lyrics)      |
| `'haiku-generate'` | "Lyrics recalled from AI — may be inaccurate." |
| absent (legacy)    | "AI-sourced lyrics. May be inaccurate." (until enriched) |

No other rendering changes. The `chorus-snippet` /
`rejected-snippet` div structure, quote marks, and inline
`LyricsTrigger` chip stay as-is.

## Out of scope

- **Lyrics popover.** Already uses LRCLIB directly with the new
  disambiguation. Unchanged.
- **AI context.** `renderCandidates` in `userMessage.ts` stops
  sending snippets to the AI. The AI doesn't need lyrics for song
  selection and slot placement.
- **Per-card re-enrich button.** The lyrics popover chip is the
  escape hatch for wrong snippets. No new UI for snippet refresh.
- **Proactive server-side enrichment.** No background job or
  migration script. Enrichment is lazy, triggered by the SPA.

## Testing

- **`enrichSnippets` module:** Unit tests with mocked Firestore
  cache reads, mocked `fetchFromLrclib`, and mocked Haiku
  responses. Cover: all-cached, all-miss, mixed, Haiku error
  fallback, empty input.
- **Callable:** Integration-style test with mocked deps (same
  pattern as `getLyricsForSong` tests).
- **`useCandidatePool` enrichment trigger:** Verify enrichment
  fires for absent `snippetSource`, skips for present, deduplicates
  in-flight calls.
- **Rendering:** Verify shimmer shows during enrichment, snippet
  replaces shimmer on completion, correct tooltip per source.
- **Prompt removal regression:** Verify `propose_songs` and
  `classify_song` tool schemas no longer include `chorusSnippet`.
  Structural assertion on tool definitions (same pattern as existing
  prompt-structure tests).
