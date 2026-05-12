# Songpicker — Claude conventions

## User-facing language

- **Never use the acronym "PCO" in any user-visible string** — labels,
  button text, tooltip text, error messages, etc. Always say
  "Planning Center". The acronym isn't well-known to worship leaders
  outside developer circles. Internal identifiers (CSS class names,
  variable names, file paths, code comments) can use `pco` freely.

## Planning Center API gotchas

These are non-obvious things we've burned time on; don't relearn them.

- **`?q=` is broken on `/songs`.** PCO silently ignores the parameter
  and returns the library in default order. Use
  `?where[title]=<title>` (case-insensitive exact match) instead.
  `?where[title_like]=` is also silently ignored. See
  `functions/src/pco/client.ts` searchSongs for the working pattern,
  with a parenthetical-stripped retry for AI titles like
  "How Great Is Our God (Hillsong)".
- **`item_type` is unreliable.** Many plans store everything as
  `"item"` even for song slots. Use the title heuristic in
  `functions/src/pco/songSlots.ts` (matches "Song N" or
  "Opening/Closing song") alongside the explicit type and any
  attached song. Mirror copy in `src/lib/songSlots.ts`.
- **Song leaders live in a separate resource: `ItemAssignment`.** It's
  exposed at `/items/{id}/item_assignments`, includable via
  `?include=item_assignments,item_assignments.assignable`. Each
  assignment's `assignable` is either a Person (use `full_name`) or
  a TeamPosition (use `name + " (position)"`). It's a newer PCO
  feature, and the obvious-name probes (`leaders`, `people`,
  `item_leaders`) all 404 — easy to conclude wrongly that the API
  doesn't have it.
- **Rate limit: 100 requests per 20-second window.** We mitigate with
  bounded concurrency (`pMap` in `functions/src/pco/concurrency.ts`)
  and a Retry-After-aware single retry in `PcoClient.fetch`. The
  SPA also caches `getPlanContext` per-session in `src/lib/cache.ts`
  to avoid refetching on back/forward. Don't add new code that
  fans out unbounded parallel calls per plan.
- **Don't include `listServiceTypes` inside `getPlan`.** The detail
  view doesn't render `serviceTypeName` and callers already have it
  from `listPlans`. A burned PCO call per plan-open is real.
- **`Item.sequence` is read-only via PATCH.** PCO returns "Forbidden
  Attribute" if you try to PATCH `attributes.sequence`. To reorder,
  use the dedicated action endpoint instead:
  `POST /service_types/{stid}/plans/{pid}/item_reorder` with
  `{ data: { type: "PlanItemReorder", attributes: { sequence: [id1, id2, ...] } } }`.
  One request reorders the entire plan. See
  `PcoClient.reorderPlanItems` in `functions/src/pco/client.ts`.
- **Linking a song does not auto-set the item title via the API.** The
  PCO web UI rewrites the slot's title to match the song's name when
  you pick one, but the API leaves `attributes.title` alone. PATCH the
  title alongside the song relationship in the same request. See
  `commitSlot` in `functions/src/index.ts` and the `title` option on
  `PcoClient.updatePlanItem`.
- **Item key is set via `relationships.key`, not `attributes.key_name`.**
  Reads expose `key_name` as a string attribute, but writes need a Key
  resource id (Key is a child of Arrangement). Fetch a song's
  arrangements + keys via
  `/songs/{id}/arrangements?include=keys&per_page=25`. See
  `PcoClient.listSongArrangements` and `setSlotArrangementKey`.
- **Slot title round-trip.** Because committing a song renames the
  slot to the song's title (above), clearing it needs to restore
  whatever the slot was called before. We capture that title on the
  candidate as `priorSlotTitle` at commit time, and use it on clear
  (falling back to a position-based "Song N" computed by
  `fallbackSlotTitle` when no prior is stored). Reorder/move/swap all
  null out the affected candidates' `priorSlotTitle` since the slot's
  identity may no longer match its old name.
- **priorSlotTitle taint.** Repeated commits to the same slot through
  swaps/overwrites can leave `priorSlotTitle` pointing at a previous
  song's name instead of the slot's actual placeholder. Restoring
  that on clear would label the slot with the just-removed song. The
  clear paths (`set_slot_contents` clear branch + `clearSlotAction`)
  build a set of all known song titles from candidates and items and
  treat any `priorSlotTitle` matching that set as tainted, falling
  back to `fallbackSlotTitle`. The commit path snapshots
  `preTurnSlotPlaceholders` at the start of each `set_slot_contents`
  action so incoming candidates inherit the slot's original
  placeholder even in mid-turn swap scenarios.
- **`PcoClient.fetch` tolerates empty response bodies.** PCO's action
  endpoints (`/item_reorder`) return 204 No Content on success.
  Calling `res.json()` on that throws "Unexpected end of JSON input"
  and was previously surfacing as a Cloud Function INTERNAL error.
  Now `fetch` reads as text first; empty → returns `undefined`,
  non-empty → JSON.parse with a better error message on failure.
- **PCO read-after-write isn't always strongly consistent.** After
  POSTing to `/item_reorder`, an immediate `listPlanItems` can
  return the pre-swap ordering for a beat. `swapSlotsAction` applies
  the reorder locally (it knows exactly what the swap should produce)
  rather than refetching, and only invalidates the per-session cache
  so a future navigate-away-and-back picks up fresh data.

## Per-user data model (Firestore, all admin-SDK-only)

- `pcoCredentials/{uid}` — `{ appId, secret, updatedAt }`. Written by
  `savePcoCredentials` (validated by calling PCO first), read by
  `pcoForUser`. Clients never see the values.
- `userPrompts/{uid}` — `{ structure, role, themes, notes }`.
  `structure` and `role` are each `{ default, byPlan }`. `themes`
  and `notes` are `{ [planId]: string }`. Read/write via the typed
  callables; clients can't touch directly.
- `appConfig/global` — admin-owned `{ structure, role }`. Edited
  through the Admin page, gated by `ADMIN_EMAILS` in
  `functions/.env`.

## Prompt-tier resolution

Both the AI persona and the service-flow prompt resolve through three
tiers in this order, and the AI debug panel always shows the final
composed value:

  per-plan override → user default → admin override → hardcoded fallback

The hardcoded fallbacks live in `functions/src/prompts.ts`
(`DEFAULT_STRUCTURE_PROMPT`, `DEFAULT_ROLE_PROMPT`). The non-editable
technical instructions (`TECHNICAL_REQUIREMENTS`) — tool-usage
guidance, the "never narrate an action you didn't take" rule, the
"replace ≠ reject" disambiguation — are concatenated to the resolved
role before being sent as the model's system message. Never surfaced
to users via the persona editor, only visible read-only on the Admin
page.

## AI provider

- Anthropic Claude Sonnet 4.6, via `@anthropic-ai/sdk`. Single
  provider — we used to abstract over Gemini and OpenAI too, but
  trimmed those out. The `AiProvider` interface in
  `functions/src/ai/types.ts` is kept so a future provider can slot
  in, but `getAiProvider()` just returns `AnthropicProvider`.
- `suggestSongs` returns a `debug` payload via `buildUserMessage` so
  the SPA's debug panel always reflects what was actually sent.
- **Streaming via `messages.stream`** — the callable in
  `functions/src/index.ts` declares its third Stream generic and
  pipes per-chunk content (text deltas + completed tool_use blocks
  parsed into `AiAction`s) through `res.sendChunk`. The SPA consumes
  via `suggestSongs.stream(payload)` and appends text into the
  in-flight assistant message as it arrives.
- **Tool use with `tool_choice: 'auto'`** instead of JSON output.
  Four tools today: `propose_songs`, `remove_candidates`,
  `set_slot_contents` (unified slot-state setter — handles commit,
  move, swap, overwrite, clear via assignments[]), and
  `unreject_candidates`. Tool results aren't fed back (no
  `tool_result` round-trip); the next turn's candidates block
  reflects consequences.
- **Cache breakpoints** on the system prompt and on the stable half
  of the user message (theme + plan notes + structure +
  serviceOrder). Volatile half (candidates + alreadyInPlan + user
  request) is fresh every turn. Default 5-min TTL — sessions can
  span hours, so the cache is opportunistic, not load-bearing.
- **Content-filter retry.** Anthropic's output safety filter
  occasionally trips on innocuous worship prompts. `AnthropicProvider`
  retries once on that specific error AND only if no chunks have
  been forwarded yet (to avoid double-emitting text on the client).
  Second failure is rewritten to a friendlier user-facing message;
  the `suggestSongs` callable wraps everything in
  `HttpsError('aborted', message)` so the client doesn't see
  `INTERNAL` for AI-side failures.

## Dev workflow

- **Node 22** (`.nvmrc`). `nvm use` in any shell working on this
  repo. Cloud Functions engines.node = "22".
- **`npm run dev` is the only command you should need.** It wraps
  `firebase emulators:exec` around `concurrently` (vite + tsc-watch).
  Single Ctrl-C, then **wait** for "export complete" — pressing
  again forces abort and corrupts the export.
- Emulator state is persisted to `.emulator-data/` via import +
  export-on-exit. Gitignored.
- `functions/.env` for emulator-time `defineString` params
  (`ALLOWED_EMAIL`, `ADMIN_EMAILS`, `INCLUDED_SERVICE_TYPES`). Pushes
  to prod on `npm run deploy`.
- `functions/.secret.local` for emulator-time secret values
  (`PCO_APP_ID`, `PCO_SECRET`, `ANTHROPIC_API_KEY`). Bootstrap from
  prod with `firebase functions:secrets:access <NAME>`. Gitignored.

## SPA patterns

- Hash-based routing in `App.tsx` — no router library. Routes:
  `#` (plan list), `#plan/<serviceTypeId>/<planId>` (detail),
  `#admin`.
- Per-plan editable fields (theme + service-notes) auto-save 600ms
  after the last keystroke (`userTouchedTheme` / `userTouchedNotes`
  refs guard the initial seed). Reset buttons clear the override
  immediately. Saving an empty string is the "no override" sentinel.
- Sparkle / AI-gradient styling is reserved for the explicit AI
  moments now: the Suggest button, the AI Candidates heading, the
  "AI" role tag in the chat log, and the persona / service-flow
  prompt pills. Don't re-add `ai-context-marker` decorations onto
  every input that feeds the AI — Matt asked us to strip those
  because the whole flow is so obviously AI-driven that the icons
  just added noise.
- **setItems(fresh) before setCandidates(…) after PCO mutations.**
  PlanDetail has a reconciliation `useEffect` watching `[items,
  candidates]` that strips `committedAt` off any candidate whose
  slot looks empty in items. If you call `setCandidates(committed)`
  before the `setItems(fresh)` that reflects the new PCO state,
  React renders once with new-candidates-vs-stale-items, the
  effect resets `committedAt`, and the candidate flickers back to
  un-committed. Put the `setItems(fresh)` first so both setStates
  batch into a single render with consistent state. The transient
  `commitPending` flag on `CandidateMatch` shields a candidate
  from this effect while a PCO write is mid-flight; cleared in the
  same render as `setItems(fresh)` after the response lands.
- **Per-plan DnD uses HTML5 drag-and-drop with our own ghost.**
  Quirks worth remembering:
  - Anchor (`<a>`) children of draggable rows must set
    `draggable={false}` — anchors are URL drag sources by default
    and hijack the row's dragstart otherwise.
  - `dataTransfer.getData` for custom mime types is unreliable
    cross-browser (Firefox restricts custom types in drop events).
    We thread the source identity through React state
    (`dragKind` + `dragSourceId`) instead, and only set
    `text/plain` on dataTransfer to keep Firefox accepting the drag
    at all.
  - The browser's drag-image rendering is unreliable too. We
    suppress it with a 1×1 transparent canvas via `setDragImage`
    and render our own labeled chip from a document-level
    `dragover` listener that tracks the cursor.
- **Auto-refresh after reject signals is threshold-gated.**
  `scheduleAutoRefine` debounces 5 seconds after the most recent
  reject or reject-reason save. The timer's callback only fires the
  AI turn if `unservedRejectsRef >= 2` OR `unservedReasonSavesRef >=
  1` — a single click-only reject doesn't trigger a chat turn. When
  it fires, it routes through `handleSuggest({ autoRefresh: true })`,
  which appends a `↻ Auto-refining…` system marker (no synthetic
  user-prose turn) and passes `autoRefresh: true` to the AI so the
  prompt switches into terse mode (commits/clears are disallowed
  during auto-refresh; the SPA also drops them as belt-and-
  suspenders).
- **Action layer for PCO writes.** `placeSongAction`,
  `clearSlotAction`, `swapSlotsAction` in `PlanDetail.tsx` are the
  single source of truth for slot-state changes. Both manual flows
  (DnD, candidate slot picker) and AI tool calls go through them.
  Each handles: optimistic state, the Cloud Function call,
  rollback on failure, items refresh (or `deferRefresh` for AI
  batched turns), and the chat-log system message. `source: 'user'
  | 'ai'` switches message formatting.
- **AI turns batch PCO writes in two phases.** A `set_slot_contents`
  action can include any mix of commits and clears (including swaps
  expressed as two-slot assignments). Each assignment's optimistic
  state update applies as it arrives in the stream, but the actual
  PCO calls land in `plannedClears` / `plannedCommits` Maps and only
  fire after the stream ends, in strict order: Phase 1 all clears,
  Phase 2 all commits. This makes swaps land cleanly (no
  clear-of-A-overwrites-B race), and the `liveCommittedSlot` tracker
  re-evaluates each action's source slot against the latest in-turn
  state instead of the pre-turn snapshot.
- **Decision: `'pending' | 'reject'` only.** The shortlist
  intermediate state was removed; candidates are either active
  (`'pending'`, possibly committed via `committedAt`) or rejected.
  Sessions persisted before this change collapse old `'shortlist'`
  values to `'pending'` via the sanitizer in `functions/src/sessions.ts`.
- **Reject rationale + chip pool.** Each rejected candidate can carry
  a `rejectReason` (typed freeform or picked from the global chip
  list at `appConfig/rejectionReasons`). Chips are app-wide and
  AI-distilled: freeform reasons feed a Claude call in
  `functions/src/ai/distill.ts` once the log crosses a threshold,
  proposing new chip-worthy categories. Reasons go into the AI
  payload as part of each candidate's metadata.
- **Per-turn context compaction.** Two patterns reduce per-turn
  token count regardless of cache state: (1) candidates the AI saw
  on a prior turn drop their `chorusSnippet` from subsequent payloads
  via `lastSentCandidateIdsRef` (title + author always stay so
  same-named songs disambiguate); (2) chat history beyond
  `HISTORY_PROSE_CAP` (8 prose messages) drops old prose entirely
  and collapses old `[event]` system messages into one `[summary]`
  line of category counts at the top of history. See
  `buildAiHistory` and `summarizeOldEvents`.

## Feedback rules picked up so far

- **Don't auto-migrate or auto-strip user data.** Matt rejected a
  loadUserNotes prefix-stripper because the right answer was a Reset
  button, not silently rewriting saved content.
- **Discuss substantive design choices in prose before issuing
  AskUserQuestion.** Matt's already-saved feedback in memory — and
  visible in his early-conversation pattern — confirms it.
- **The chat log can't lie about what changed.** System messages
  must reflect actual state changes, not just the AI's stated
  intent. If a tool action silently no-ops (e.g.,
  `remove_candidates` on a committed song, or an AI move that ran
  into an evicted candidate), suppress or replace the message
  rather than emitting a misleading "succeeded" line.
- **Replace / swap / move ≠ reject.** The user's typical workflow
  is iterative slot rearrangement, not curatorial pruning. When in
  doubt between "the user wants this song gone" and "the user
  wants this song displaced," default to displacement. The current
  `remove_candidates` prompt enumerates the verbs that DON'T mean
  reject (remove, swap, replace, switch out, trade, exchange) and
  reserves rejection for unambiguous dislike phrases.
- **Position-based fallbacks beat stored state in long sessions.**
  `priorSlotTitle` is useful when fresh, but accumulates taint
  across repeated overwrites. Detect taint (compare against all
  known song titles) and fall back to `fallbackSlotTitle` ("Song
  N" by song-slot index) rather than restoring a possibly-wrong
  cached value. Losing a custom slot name is better than restoring
  the just-cleared song's title.
