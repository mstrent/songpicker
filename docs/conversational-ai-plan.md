# Conversational AI refactor — plan

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

### Layer 3 — Replace "Refine" with a chat send; let the AI emit actions

Biggest change. Expand response schema beyond `suggestions`. Use
Anthropic tool use (cleaner than JSON for multi-action turns):

- `propose_songs(suggestions[])` — today's behavior.
- `remove_candidates(ids[], reason)` — AI asks to drop candidates
  that no longer fit.
- `reassign(candidateId, slotRole)` — AI moves a candidate to a
  different slot.
- `reply(message)` — prose explanation ("I dropped Cornerstone since
  you said too upbeat, and I'm swapping in House of the Lord for the
  opener").

Cloud Function returns `{ actions: [...], message }` instead of
`{ suggestions, assistantMessage }`. Client applies actions:
`propose_songs` appends as today; `remove_candidates` flips
`decision='reject'` with a system-message marker; `reassign` updates
`assignedSlotItemId`. The `reply` goes in the chat log in place of
`buildAssistantSummary`.

This layer is what flips the feel from "search box" to "chatbot."

For Gemini/OpenAI parity, keep a JSON-shaped fallback schema with the
same action union. Anthropic gets native tool use.

### Layer 4 — Drop or repurpose silent auto-replacement

With Layer 3 the AI handles replacement inside a single visible turn.
`scheduleReplacement` (`PlanDetail.tsx:484`) can be deleted — its
purpose was masking the append-only constraint. Optionally keep as a
"give me 3 more" button for plain-quantity refills.

### Layer 5 (optional, larger) — Streaming + cache breakpoints

Once `assistantMessage` is real prose (could be a few sentences),
latency matters.

- Switch `suggestSongs` from `onCall` to a streaming HTTPS endpoint.
  Callable functions don't stream. Anthropic SDK supports
  `messages.stream`.
- Add `cache_control` breakpoints to the *user* turn prefix (theme +
  structure + serviceOrder + planNotes) — not just the system prompt
  as today (`anthropic.ts:22`). Conversational mode means many short
  refining turns where this prefix barely changes; cache hits should
  dominate.

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
