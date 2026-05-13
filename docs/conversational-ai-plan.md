# Conversational AI refactor — plan

> **Historical note (May 2026):** Layer 2 (reject rationale + chip
> pool) was ripped out. Reject is boolean now — no reason field, no
> chip pool, no rationale picker, no `recordRejectReason` /
> `getRejectionReasons` callables, no `distill.ts`. See
> `feedback_no_reject_reasons.md` in agent memory for the rationale
> (per-candidate reasons risk overgeneralizing one rejection's framing
> onto unrelated songs). The Layer 2 sections below are kept as
> historical record of the refactor, not as current architecture.

Goal: turn the Suggest/Refine loop into an actual chat. Today every
turn is a stateless "give me more songs that aren't on this blacklist"
re-prompt. We want the AI to see the full state of the page (current
candidates with IDs/decisions/slot assignments, user rationale,
committed picks, event history) and to act on it — propose songs,
remove candidates, reassign slots, reply in prose — instead of only
appending suggestions.

## Why the AI feels append-only today

- **Client → AI payload** (`functions/src/ai/userMessage.ts:11`,
  `src/components/PlanDetail.tsx:349`) sends `theme`, latest
  `userMessage`, `serviceOrder`, `planNotes`, `exclude`, and bare
  arrays of `shortlistedTitles` / `rejectedTitles`. Plus a `history`
  of prior user/assistant pairs.
- **What the AI never sees**: candidate IDs, the AI-generated chorus
  snippet it returned last time, *why* a song was rejected, which
  candidate is queued against which slot, what the user committed and
  when, and any of the in-app system messages
  (`PlanDetail.tsx:367-371` explicitly filters `role !== 'system'`).
  The "assistant" turn it sees back is just `buildAssistantSummary()`
  (`userMessage.ts:54`) — a synthetic bullet list, not the AI's own
  words.
- **What the AI can return**: only `{ suggestions: [...] }`
  (`functions/src/ai/types.ts:53-60`). Every call must produce *new*
  songs; the `exclude` list forbids reuse, so the model can't say
  "keep #3, swap #1, drop #5" — it can only add. The client then
  unconditionally **appends** (`PlanDetail.tsx:426`).
- **Auto-replace on reject** (`PlanDetail.tsx:484`) papers over this
  by silently re-prompting for N more after rejections, but the AI
  still doesn't know it's a "replace," only that it's been asked for
  more.

Net effect: each turn is a fancy search, not a conversation.

## The plan — five layers, smallest to largest

Each layer is shippable on its own.

### Layer 1 — Send the full candidate state, not just title arrays

Replace flat `shortlistedTitles` / `rejectedTitles` with a single
`candidates` block in the user message:

```
Current candidates:
  c_abc — "Cornerstone" (Hillsong) — pending — chorus: "Christ alone, cornerstone"
  c_def — "Build My Life" (Pat Barrett) — shortlisted — assigned to slot 3 (mid)
  c_ghi — "Goodness of God" (Bethel) — rejected — reason: "too slow for opener"
  c_jkl — "Holy Spirit" (Francesca) — committed to slot 1 (opener)
```

A `userMessage.ts` change plus a new builder in `PlanDetail.tsx` that
walks `candidates` and `items`. Once the AI sees IDs, it can refer to
them in its reply. (It also makes `exclude` redundant *within* the
candidate pool — but keep `exclude` for PCO-already-picked songs that
aren't in our state.)

### Layer 2 — Capture and surface user rationale (shipped)

Rationale UI lives on the rejected-pool card, not the active card.
Reject stays a one-tap action; the pool auto-opens the first time
anything gets rejected and a rationale picker renders above the
rejected list, scoped to the just-rejected ("focused") candidate:

- A row of one-tap chips (the global "common reasons" list).
- A freeform textarea (Enter to save, Shift-Enter for newline).
- A Save button; Skip dismisses without saving.

Each rejected card shows its captured reason inline with an `edit`
link, or `+ add reason` when none was captured.

**Common reasons are a global app-wide pool**, stored in
`appConfig/rejectionReasons`:

```ts
{
  common: [{ text, addedAt, source: 'manual' | 'ai' | 'seed' }],
  recentFreeform: [{ text, at }],   // FIFO cap 100
  lastDistilledAt: number,
  freeformSinceDistill: number,
  seeded: boolean,
}
```

Three callables: `getRejectionReasons`, `recordRejectReason({reason})`,
`removeCommonReason({text})`. First read seeds a starter set ("Too
slow", "Too upbeat", "Already played recently", "Doesn't fit the
theme", "Hard for the congregation to sing") and sets `seeded: true`
so removals are sticky.

**AI distillation**: when `freeformSinceDistill` crosses 8,
`recordRejectReason` fires a Claude call inline (`functions/src/ai/distill.ts`)
that takes the last ~50 freeform reasons plus the existing chip list
and proposes up to 5 new chip-worthy categories not already covered.
Distillation failures are swallowed and the counter is preserved so
the next call past threshold retries.

Chip clicks set the candidate's reject reason locally (no server
call — the reason already exists as a chip). Only freeform Save
calls `recordRejectReason`, which feeds the global log + maybe
triggers distillation.

System messages — previously filtered out of the AI history at
`PlanDetail.tsx:367-371` — now get folded in as synthetic user-side
`[event] …` lines so the AI sees decision events in conversation
order alongside typed user turns.

### Layer 3 — Replace "Refine" with a chat send; let the AI emit actions (shipped)

Anthropic tool use (no more JSON-output instruction). Three tools the
model can invoke in any combination per turn:

- `propose_songs({ suggestions: [...] })` — add candidates (existing
  behavior).
- `remove_candidates({ ids, reason })` — mark existing candidates
  rejected with an AI-supplied reason. SPA flips decision to reject,
  stores the reason in the same `rejectReason` field the user UI
  uses, and emits a `🤖 AI rejected …` system message in the chat
  log. Skips committed candidates defensively.
- `reassign({ candidateId, slotIndex })` — change a candidate's
  earmark to a different 1-based song-slot position. SPA maps the
  index back to a PCO item id.

The model's prose reply comes from its `text` content block — no
`reply` tool, no synthesized bullet list. If the model only calls
tools with no text, a short fallback synthesizes from the action
counts so the chat log never goes silent.

`SuggestResult` returns `{ actions: AiAction[], message: string,
debug }` instead of `{ suggestions, assistantMessage }`. Client
applies actions in order with defensive guards: dedupes propose by
title (case-insensitive against current candidates + alreadyInPlan,
plus within the same turn), skips reassign with out-of-range slot
indices, leaves committed candidates untouched.

Tool result loops sidestepped: the SPA stores only the prose-text
version of each assistant turn in history, so the model never sees
its own past `tool_use` blocks. The next turn's candidates block
reflects the consequences of those calls — no `tool_result` round-
trips needed.

UI: min/max count inputs are gone; the AI picks how many to propose
per turn based on the structure-prompt role count and current pool.
Button label collapses to "Send" / "Suggest songs" (first turn) /
"Thinking…" (in-flight). Enter sends, Shift+Enter newlines.

### Layer 4 — Drop silent auto-replacement (shipped)

`scheduleReplacement`, `pendingReplacements`, `replacementTimer`,
`candidatesRef`, `maxCountRef` all gone. The 600ms debounced
auto-refill that ran silently after each Reject is now the AI's
responsibility — if the user rejects something, they can ask the AI
for replacements in the next turn, or the AI can preemptively offer
some in its reply. Same outcome, but visible and conversational.

### Layer 6 — Agentic PCO write tools (shipped)

Three new tools added to the streaming chat turn so the AI can take
real-world actions in Planning Center, not just rearrange the SPA's
candidate pool. "Direct with undo" safety model: every AI write
goes through immediately, emits a `🤖` system message in the chat
log, and is reversible via the existing service-order UI.

- `commit_song({ candidateId, slotIndex })` — actually fills a
  Planning Center song slot via the existing `commitSlot`
  callable. Optimistic state flip (committedAt set immediately),
  PCO call fires fire-and-forget, rollback on failure with a `⚠`
  system message. Skipped with a warning if the candidate isn't
  matched to a PCO library song.
- `clear_slot({ slotIndex })` — backs out a committed slot via
  `clearSlot`. Captures a per-turn rollback snapshot so a failed
  clear restores the candidate's committed state. Restores the
  prior slot title using `priorSlotTitle` if known, falling back
  to `fallbackSlotTitle`.
- `unreject_candidates({ ids })` — symmetric to
  `remove_candidates`, lets the AI walk back rejections.

Auto-refresh guard: `commit_song` and `clear_slot` are disallowed
during auto-refresh turns. The system prompt tells the AI so;
the SPA also drops the action with a `⚠` system message as
belt-and-suspenders.

Multiple writes in a single turn fire optimistically as they
arrive in the stream, then the post-stream cleanup
`await Promise.all(pendingPcoWrites)` and runs ONE
`loadPlanContext` refresh to pick up all the resulting PCO
state in a single read.

Cost: three new tool schemas live in the Anthropic tools array,
which sits inside the cache breakpoint — paid once per session,
not per turn. Still one Anthropic round trip per turn; no
tool-result loops.

Scope deliberately excluded for this pass: library search,
cross-session memory, set-arrangement-and-key, full plan
reorder. None of those land here.

### Layer 5 — Streaming + cache breakpoints (shipped)

**Streaming.** `firebase-functions` v7 callables natively support
streaming via `onCall(opts, async (req, res) => { res.sendChunk(…) })`
plus the client's `httpsCallable(...).stream(payload)`. Each chunk is
a tagged `StreamChunk`:

- `{ kind: 'text', delta }` — appended to the in-flight assistant
  message as it arrives.
- `{ kind: 'action', action }` — a fully-decoded tool call, applied
  the moment its JSON arrives (proposes mint candidates, removes
  flip `decision=reject`, reassigns update `assignedSlotItemId`).

`anthropic.ts` switched from `messages.create` to `messages.stream`
and iterates events: `content_block_start` opens a tool buffer,
`content_block_delta` feeds either text deltas to `onChunk` or
partial tool JSON into the buffer, `content_block_stop` finalises a
tool by parsing its buffered JSON. The final aggregated message is
still parsed once the stream completes so the `SuggestResponse`
return value carries `actions` + `message` + `debug` for callers
that prefer the non-streaming shape (and so the SPA can still pull
`debug` off the resolved `data`).

The SPA reserves an assistant message id up front, appends text
deltas into its content in-place, applies each action chunk as it
arrives (with the same dedupe + slot-mapping guards as before), and
falls back to `final.message` if the stream produced no text. A
typing-cursor (▍ blinking) renders on the last assistant message
while `generating` is true; the chat log auto-scrolls to the bottom
on every message update.

**Cache breakpoints.** `buildUserMessage` now returns
`{ stable, volatile }`. The user message goes to Anthropic as two
content blocks; the stable block (theme + plan notes + structure +
service order) carries `cache_control: { type: 'ephemeral' }`. The
system prompt keeps its existing cache marker. Both breakpoints are
no-ops below Anthropic's 1024-token minimum, but kick in for larger
sessions and compound across turns. `flattenUserMessage` is used for
the SPA debug panel.

## Sequencing

1. Layer 1 + 2 in one PR. AI starts seeing real state and rationale
   even before its output shape changes. Rejections become
   informative instead of just exclusions.
2. Layer 3 in a second PR. Tool use, real prose reply, action-based
   response. Users feel the chatbot here.
3. Layer 4 cleanup with (3). Delete `scheduleReplacement` once the AI
   is responsible for swaps.
4. Layer 5 only if/when conversational latency becomes the pain
   point.

## Risks and gotchas

- **JSON-parse fragility (`anthropic.ts:31`)**: tool use sidesteps
  `extractJson` for Claude. Keep the fence stripper for Gemini /
  OpenAI.
- **`exclude` semantics shift**: today `exclude` includes
  PCO-already-picked song titles (`PlanDetail.tsx:352-354`). Keep
  that when replacing flat title arrays with structured candidates —
  committed-in-PCO songs aren't candidates in SPA state, so they
  still need an explicit don't-suggest hint.
- **Session storage**: `messages[]` already persists via
  `saveSession`. Richer assistant messages serialize as strings — no
  schema change.
- **Per-plan cache** (`src/lib/cache.ts`): `getPlanContext` is fine;
  conversational state lives in the session, not the plan context.
- **Anthropic rate**: more turns = more API calls. Sonnet 4.6 is
  fast and cached prefixes are cheap; non-issue, but measure after
  Layer 3.

### Layer 7 — Action layer + drop shortlist + drop reassign (shipped)

The PCO write surface had three layers tangled together: six SPA
orchestrators each doing PCO call + optimistic state + items
refresh + system message (with subtly different rollback). Cleaned
up into a clear stack:

- **PcoClient primitives** (server, low-level): `updatePlanItem`,
  `clearPlanItemSong`, `reorderPlanItems`. Unchanged.
- **Intent-shaped Cloud Functions**: `placeSongInSlot` (handles
  fresh commits and moves via optional `fromSlotItemId`),
  `clearSongFromSlot`. `reorderItems` stays for the swap case
  used by the SPA's swap action.
- **SPA action layer**: `placeSongAction`, `clearSlotAction`,
  `swapSlotsAction`. Both DnD/manual flows and AI tool handlers
  call these. Each does optimistic state + Cloud Function +
  (optional) items refresh + rollback + system message.
  `source: 'user' | 'ai'` parameter switches message formatting.

Same change dropped the shortlist intermediate decision state.
`Decision` is now `'pending' | 'reject'`; committed candidates
are identified via `committedAt`. The Shortlist button is gone;
the slot picker dropdown on a matched candidate commits directly
on selection. AI's `reassign` tool also dropped — its job
("earmark without committing") depended on shortlist, and the
move case is now handled atomically by `commit_song`'s
`fromSlotItemId`.

Old `commitSlot` / `clearSlot` Cloud Function callables removed
after migration; their orphaned CSS classes
(`.decision-shortlist`, `.commit-btn`, `.unassign-btn`,
`.assigned-arrow`) cleaned up.

### Layer 8 — Unified set_slot_contents tool (shipped)

The AI tool surface for slot changes had `commit_song` (with
atomic move semantics) plus `clear_slot`, and the user-driven
swap was a separate `reassign`-or-DnD path. Swaps were the AI's
biggest stumbling block: it had to coordinate two `commit_song`
calls in one turn and frequently dropped one half or
hallucinated success without emitting either.

Replaced both AI slot tools with a single declarative tool:

`set_slot_contents({ assignments: [{ slotIndex, candidateId | null }, ...] })`

Each assignment says what one slot should contain (a candidate
id, or `null` to clear). The SPA computes the diff from current
state and runs the existing two-phase batched PCO writes:

- **Phase 1** clears every source slot (slots a moving candidate
  is leaving, slots explicitly set to `null`)
- **Phase 2** commits each target slot via `placeSongInSlot`
  (no `fromSlotItemId` — phase 1 already cleared sources)

This single shape covers fresh commit, move, overwrite, swap, and
multi-slot batches. The AI's `liveCommittedSlot` Map tracks each
candidate's position through in-stream optimistic moves so action
N+1's "where is this candidate currently?" check sees action N's
eviction. `plannedClears` and `plannedCommits` Maps are keyed by
slot id so duplicate ops dedupe naturally; a clear of a slot
that's also a commit target gets dropped (the commit overwrites).

System messages for `set_slot_contents` classify each assignment
locally: detects swap pairs (two assignments where the candidates
swap their current slots) and emits one `🤖 AI swapped X and Y`
message instead of two separate "moved" lines. Single-assignment
operations get committed/moved/cleared messages as before.

Drop list: `commit_song`, `clear_slot` tool schemas and the
matching SPA action branches. AiAction union shrunk to four
kinds (propose / remove / set_slot_contents / unreject).

### Bug fixes worth recording (post-Layer-8)

- **PCO `item_reorder` returns 204 No Content.** `PcoClient.fetch`
  was unconditionally calling `res.json()`, which threw "Unexpected
  end of JSON input" on every reorder. Fixed by reading as text
  first and returning `undefined` for empty bodies. This surfaced
  as the "DnD swap appears to fail" bug — PCO accepted the
  reorder, but the response broke our fetch wrapper and the SPA
  rolled back its optimistic update.
- **PCO read-after-write on reorder isn't strongly consistent.**
  Even with the empty-body fix, an immediate `listPlanItems`
  could return the pre-swap ordering. `swapSlotsAction` now
  applies the reorder locally (it knows the deterministic result)
  rather than refetching. Cache invalidation still happens so a
  future navigate picks up fresh data.
- **`priorSlotTitle` taint detection.** Repeated swaps could
  leave a candidate's `priorSlotTitle` pointing at a previous
  song's name instead of the slot's original placeholder.
  Restoring that on clear would label the slot with the
  just-removed song. The clear paths now build a set of all
  known song titles (from candidates + items.songTitle) and
  treat any `priorSlotTitle` matching the set as tainted,
  falling back to `fallbackSlotTitle`. The commit path
  snapshots `preTurnSlotPlaceholders` at the start of each
  `set_slot_contents` action so inheritance through swaps
  works correctly.
- **Anthropic content-filter retry.** The safety filter
  occasionally trips on innocuous worship prompts. The provider
  retries once on that specific error, but ONLY if no chunks have
  streamed yet (otherwise the retry would double-emit text on
  the client). A second failure is rewritten into a friendlier
  user-facing message; the `suggestSongs` callable wraps the
  whole thing in `HttpsError('aborted', message)` so the client
  doesn't see `INTERNAL` for AI-side failures.
- **Prompt tightenings.** Several iterations of
  `TECHNICAL_REQUIREMENTS`:
  - "Never narrate an action you didn't take" — the AI was
    occasionally writing prose like "Done — committed X to slot
    2" without actually emitting the tool call.
  - "Be brief — one short sentence at most, no recap of the
    resulting state" — model was over-explaining.
  - "Remove / swap / replace / switch out ≠ reject" — the AI
    was misreading "remove X and replace with Y" as a rejection
    of X plus a commit of Y. Now defaults to displacement when
    the user's intent is ambiguous between rejection and
    displacement.

### Layer 9 — Per-turn context optimization (shipped)

After the conversational refactor stabilized, sessions could
grow long (many turns, many candidates, many event markers in
history). Anthropic's cache helps cost but doesn't bound token
count, and worship-leader sessions span unpredictable durations
so the cache is opportunistic at best. Two optimizations that
reduce per-turn payload regardless of cache state:

**Candidates compaction.** After the first turn a candidate
appears in the payload, subsequent turns omit its
`chorusSnippet` — the largest stable field. Title + author
always go through so same-named songs disambiguate.
`lastSentCandidateIdsRef` tracks the most recent send;
newly-proposed candidates count as "AI just saw them" too.
Resets on Clear conversation and plan switch, and naturally on
tab close (since it's a ref). Tab-reopen gives a full intro,
which is a feature.

**History pruning.** Two-tier. Below
`HISTORY_PROSE_CAP` (8 prose messages, ~4 turn-pairs): full
history verbatim. Above: keep the most recent N prose turns
plus any `[event]` markers after them, collapse older events
into a single `[summary] Earlier in this session: X proposed,
Y rejected, Z committed, ...` line at the top of history.
Pattern-matches the system message prefixes
(✗ Rejected / 🤖 AI committed / ↗ Committed / etc.) and emits
category counts. Specifics deliberately dropped — the current
candidates block + service order carry the state that matters.

Both compactions live in `buildAiHistory` /
`buildUserMessage` and stack with the existing cache
breakpoints.
