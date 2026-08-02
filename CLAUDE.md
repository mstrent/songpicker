# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite + Functions tsc-watch + Firebase emulators (functions + firestore), single Ctrl-C exits all three. **Wait** for "export complete" — pressing Ctrl-C again corrupts the emulator export at `.emulator-data/`.
- `npm run build` — `tsc -b && vite build` (SPA). Functions build separately: `npm --prefix functions run build`.
- `npm run lint` — ESLint over the repo.
- `npm test` — Vitest, in-process, fast. Watcher: `npm run test:watch`.
- Run a single test file: `npm test -- src/lib/planActions/resolver.test.ts`.
- Filter by test name: `npm test -- -t "swap"`.
- `npm run deploy` — SPA build + `firebase deploy` (hosting + functions + firestore rules).
- Node 22 only (`.nvmrc`). `nvm use` in any new shell.

Testable surface: pure helpers, the slot-state resolver, the executor (with mocked callables), and the `usePlanData` / `useCandidatePool` hooks. We don't render-test PlanDetail for state correctness.

## Repo shape

- `src/` — React SPA (Vite + TS). `App.tsx` is auth gate + hash router; `components/PlanDetail.tsx` composes `usePlanData` (plan-side) and `useCandidatePool` (songpicker-side); `lib/planActions/` holds the resolver + executor + helpers; `lib/callables.ts` wraps typed Cloud Function clients.
- `functions/src/` — Cloud Functions (Gen 2, TS, Node 22). `index.ts` exports all callables; `pco/` is the PCO REST client (plain fetch, no SDK); `ai/` holds the Anthropic provider + `buildUserMessage`; `prompts.ts` has the hardcoded fallbacks; `sessions.ts` persists the candidate pool; `slotPlaceholders.ts` reconciles the per-plan restore-title map.
- `docs/unification-plan.md` — active refactor toward the architecture below; check the current phase before redesigning slot-state code.
- `README.md` — user-facing overview, callable-function table, PCO endpoint table, first-time setup. Read it once; don't duplicate its contents here.

## Architecture philosophy

- **PCO is the source of truth for plan state. Songpicker owns the
  candidate pool.** These are separate concepts that touch only at
  the boundary where a candidate gets committed to a slot. The plan
  (slots + their linked songs + their titles) lives in PCO; we
  mirror it in the SPA's `items` + `slotPlaceholders` state. The
  candidate pool (AI suggestions, decisions, chat) is songpicker-
  internal — it doesn't exist in PCO. The candidate pool's job is
  upstream of slot-filling: candidates exist to help the user/AI
  decide what should fill the plan's slots. Once a slot is filled,
  PCO owns that fact.

  Implication: **"Is candidate X currently committed to a slot?" is
  *derived* state, not stored.** The answer is `items.find(it =>
  it.songId === candidate.song?.id)`. We don't track committed
  status on candidates; we read it off PCO's items. This avoids
  whole categories of drift bugs (the reconciliation effect that
  used to compensate for divergence is gone).

  Implication: **Slot operations work on song refs, not candidate
  refs.** Commit / clear / move / swap take `{songId, songTitle}`
  pulled from a candidate's matched library song OR straight from
  PCO's items. This means the same operations work for songs that
  were placed via PCO web UI (no candidate record) and songs the
  AI suggested. No special PCO-direct fallback needed.

- **Prefer breaking both paths with the same bug.** When the AI flow
  and the UI flow do the same thing (commit a song, clear a slot,
  swap two slots, reject a candidate), they should share the same
  code, not parallel implementations. Two implementations always
  drift — we've already lived this with eviction logic, restore-title
  resolution, and swap-vs-reorder placeholder handling. If you find
  yourself adding a feature to one path, look for the matching path
  and either refactor first or extend both at the same time.
- **Slot-state changes flow through one vocabulary**: an
  `assignments[]` array (the `set_slot_contents` shape).
  `assignments[].slotIndex` is 1-based among song slots;
  `assignments[].candidateId` is null for "empty this slot."
  Both AI tool calls and UI events (DnD drops, button clicks)
  compile to this shape. A pure resolver turns assignments into a
  Plan (PCO ops + state diffs + chat message); a single executor
  applies the Plan. **Don't add a new "shortcut" function that
  performs a slot-state change without going through the resolver +
  executor** — that's how parallel paths grow.
- **Pure functions for state transitions; side effects in the
  executor.** Helpers like `resolveRestoreTitle`,
  `findEvictionTarget`, `placeholderForSlot`, `detectSwapPairs`,
  `resolvePlan` are pure: inputs in, outputs out, no I/O. The
  executor is the only place that calls Cloud Function callables,
  mutates SPA state, or appends chat messages. Pure-function tests
  cover the resolver exhaustively; the executor is tested with
  mocked callables.
- **Stateful orchestration lives in two hooks reflecting the
  PCO/candidate split**: `usePlanData` owns the plan-side
  (PCO-mirrored items + slotPlaceholders + slot operations);
  `useCandidatePool` owns the songpicker-side (candidates +
  messages + AI driver + decisions + session persistence). The
  candidate-pool hook reads items from `usePlanData` to render
  derived state ("is this candidate currently in the plan?") but
  doesn't store it. PlanDetail composes both. **Don't put
  state-transition logic inline in the component** — extract to a
  hook or a helper.
- **Test the seam, not the rendering.** Pure helpers, the resolver,
  the executor with mocked deps, and the hook are the testable
  surface. The rendered DOM is not a substitute for unit tests on
  state logic — testing through React Testing Library conflates
  rendering bugs with logic bugs and slows the loop. Render tests
  (when we add them) stay focused on render concerns.
- **Asymmetries are deliberate, not accidental.**
  `propose_songs` is AI-only because manual candidate entry has no
  product fit yet. Auto-refine signaling fires only on UI rejects
  because AI rejects shouldn't trigger another AI turn.
  Document such asymmetries explicitly so the next person doesn't
  "fix" them — this includes the `code-simplifier` subagent / `simplify`
  skill, which should treat documented asymmetries as load-bearing
  rather than candidates for consolidation.
- See `docs/unification-plan.md` for the active refactor toward this
  architecture and which phase we're in.

## User-facing language

- **Never use the acronym "PCO" in any user-visible string** — labels,
  button text, tooltip text, error messages, etc. Always say
  "Planning Center". The acronym isn't well-known to worship leaders
  outside developer circles. Internal identifiers (CSS class names,
  variable names, file paths, code comments) can use `pco` freely.

## Planning Center API gotchas

These are non-obvious things we've burned time on; don't relearn them.

- **`?q=` is broken on `/songs`.** PCO silently ignores the parameter
  and returns the library in default order. `?where[title_like]=` is
  also silently ignored. `?where[title]=<title>` filters but the
  matching is fuzzier than the docs suggest — verified that searching
  "Surrender" returns "I Surrender", "I Surrender All", and
  "Surrender" (i.e., substring/contains, not exact). So always
  filter the API results client-side to true case-insensitive title
  equality before using them. `searchSongs` in
  `functions/src/pco/client.ts` does this, plus a parenthetical-
  stripped retry for AI titles like "How Great Is Our God (Hillsong)"
  and an optional `author` tiebreaker for the rare case where two
  library entries genuinely share the title — without the tiebreaker
  the AI's "Surrender" by Marc James would silently link to "I
  Surrender All" because PCO's default sort surfaces it first.
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
- **Slot title round-trip.** Committing a song renames the slot to
  the song's title (above), so clearing it needs to restore the
  original placeholder. The source of truth is
  `slotPlaceholders/{uid}/plans/{planId}` (server-persisted, see
  the data-model section below). The Phase 6 resolver
  (`src/lib/planActions/helpers.ts:resolveRestoreTitle`) reads from
  there on every clear; falls back to position-based "Song N"
  (`fallbackSlotTitle`) when the slot was filled before songpicker
  ever observed it empty. Pre-Phase-6 we ALSO carried a
  `priorSlotTitle` per-candidate as a backup tier — that's gone now
  along with the taint-detection it required. Items are PCO's; the
  candidate pool is separate.
- **`PcoClient.fetch` tolerates empty response bodies.** PCO's action
  endpoints (`/item_reorder`) return 204 No Content on success.
  Calling `res.json()` on that throws "Unexpected end of JSON input"
  and was previously surfacing as a Cloud Function INTERNAL error.
  Now `fetch` reads as text first; empty → returns `undefined`,
  non-empty → JSON.parse with a better error message on failure.
- **PCO read-after-write isn't always strongly consistent.** After
  POSTing to `/item_reorder`, an immediate `listPlanItems` can
  return the pre-swap ordering for a beat. We don't use
  `/item_reorder` from the slot-state path anymore — the unified
  swap is paired PATCHes on songId (items stay at their positions,
  songs swap). The reorder endpoint is only wired through
  `PcoClient.reorderPlanItems` for any future explicit reorder UI.

## Per-user data model (Firestore, all admin-SDK-only)

Inspection-only via Firebase MCP (see Tooling). Production code paths
must go through the typed callables (`savePcoCredentials`,
`getAccessConfig`, etc.) — they enforce validation that the MCP tools
bypass.

- `pcoCredentials/{uid}` — `{ appId, secret, updatedAt }`. Written by
  `savePcoCredentials` (validated by calling PCO first), read by
  `pcoForUser`. Clients never see the values.
- `userPrompts/{uid}` — `{ structure, role, themes, notes }`.
  `structure` and `role` are each `{ default, byPlan }`. `themes`
  and `notes` are `{ [planId]: string }`. Read/write via the typed
  callables; clients can't touch directly.
- `appConfig/global` — admin-owned `{ structure, role }`. Edited
  through the Admin page, gated by admin check (see access lists
  below).
- `appConfig/access` — admin-owned `{ allowedEmails, adminEmails,
  updatedAt }`. Runtime-editable email rosters. Auth resolves through
  env ∪ Firestore (see access-list resolution below).
- `slotPlaceholders/{uid}/plans/{planId}` — `{ titles: { [itemId]:
  string }, updatedAt }`. Per-plan map of song-slot itemId → the
  placeholder title PCO had on that slot the last time we observed
  it empty (`!songId`). Server reconciles inside `getPlanContext`
  via `syncSlotPlaceholders` — only writes when an empty slot's
  title diverged from the captured value (or is brand new), so most
  loads are no-ops. Phase 6's sole source of truth for restore
  titles (the prior candidate-side `priorSlotTitle` is gone). Every
  commit/clear refreshes via `refreshSlotState` which calls
  `syncSlotPlaceholders`, so renaming an empty slot in PCO between
  songpicker visits is picked up on the next load. Slots that were
  already filled the first time songpicker observed them have no
  captured placeholder — those fall back to "Song N" on clear (the
  original is unrecoverable).

## Access lists (allowed users / admins)

`requireAllowed` and `isAdminEmail` resolve from the **union** of two
sources:

1. Env values `ALLOWED_EMAIL` and `ADMIN_EMAILS` in `functions/.env`.
   These are read-only at runtime and act as **break-glass roots** —
   never removable from the Admin UI, always honored. Their job is
   to guarantee an operator can always log in even if the Firestore
   doc is wiped or wrong.
2. Firestore `appConfig/access` arrays. Managed at runtime through
   the Admin page's "Access lists" section. Cached in-memory per
   function instance with a 60s TTL (`functions/src/access.ts`).
   Writes invalidate the writer's local cache; other instances pick
   up the change on next TTL expiry.

Entry shape (env or Firestore): either an exact email
(`name@example.com`) or a domain wildcard (`@example.com`) that
matches any address at that domain. A bare `@` is rejected so a typo
can't open the gate. **Empty union fails closed** — a missing env var
plus an empty Firestore doc denies every caller; an empty env var is
never an "allow all" mode.

Admin-only callables for managing the Firestore lists:
`getAccessConfig`, `addAccessEntry`, `removeAccessEntry`. The Admin
page is hidden from non-admins via `getAdminStatus`, but server-side
`requireAdmin` is the real gate.

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

- Anthropic Claude Sonnet 5 for the main `suggestSongs` flow, via
  `@anthropic-ai/sdk`. Single provider — we used to abstract over
  Gemini and OpenAI too, but trimmed those out. The `AiProvider`
  interface in `functions/src/ai/types.ts` is kept so a future
  provider can slot in, but `getAiProvider()` just returns
  `AnthropicProvider`.
- **Default any future ancillary AI calls to Haiku 4.5**, not Sonnet.
  Keep Sonnet for the main suggestion engine; use Haiku for short
  classifier / short-label tasks where the model isn't generating
  substantive content. Several-times cheaper and faster.
- `suggestSongs` returns a `debug` payload via `buildUserMessage` so
  the SPA's debug panel always reflects what was actually sent.
- **Adaptive thinking is on** (`thinking: {type: 'adaptive'}`), set
  explicitly even though it's Sonnet 5's default when the field is
  omitted. Two consequences worth knowing before you tune anything:
  `max_tokens` is a shared ceiling over thinking *plus* response text
  (hence 16000, not the old 4000 — a turn that overruns just stops,
  with no error), and the stream carries `thinking` content blocks
  that the event loop deliberately ignores. `display` stays at its
  default (`omitted`) because we never render reasoning. Effort is
  left at Sonnet 5's `high` default; `medium` is the step-down lever
  if per-turn cost becomes a concern.
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
- **Per-candidate `inLibrary` flag in the candidates block.**
  Each `AiCandidate` includes `inLibrary: boolean` (true iff
  `c.matchStatus === 'matched'`). `set_slot_contents` commits
  defensively skip unmatched candidates with a ⚠ marker, but the
  AI also gets the field directly so it can plan around unmatched
  picks instead of trying-and-failing. Rendered inline in the
  candidates block as `— NOT IN LIBRARY (can't be committed via
  set_slot_contents)` for the false case; matched is the default
  (no tag) to keep the payload tight.
- **Cache breakpoints** on the system prompt and on the stable half
  of the user message (theme + plan notes + structure +
  serviceOrder). Volatile half (candidates + alreadyInPlan + user
  request) is fresh every turn. **1-hour TTL** via
  `cache_control.ttl: '1h'` (GA — no beta header, and the SDK types
  `ttl` directly).
  Worship-leader planning sessions span 30-90 minutes of bursty
  work, so the default 5-min cache used to expire between turns
  and we paid full prefix cost repeatedly. 1h writes cost ~2x per
  token; reads same as 5-min — net win at ≥2 hits per hour.
- **Content-filter retry.** Anthropic's output safety filter
  occasionally trips on innocuous worship prompts. `AnthropicProvider`
  retries once on that specific error AND only if no chunks have
  been forwarded yet (to avoid double-emitting text on the client).
  Second failure is rewritten to a friendlier user-facing message;
  the `suggestSongs` callable wraps everything in
  `HttpsError('aborted', message)` so the client doesn't see
  `INTERNAL` for AI-side failures.

## Tooling (installed MCP plugins)

- **GitHub MCP** (`mcp__plugin_github_github__*`) for read-only
  GitHub ops — browsing PRs/issues/commits, viewing files at refs,
  code review reads. **Writes still go through `gh` CLI** per the
  system prompt: PR creation, comments, merges, and the post-merge
  cleanup ritual all rely on its HEREDOC patterns for clean bodies,
  and the squash-merge / one-commit-per-PR convention assumes that
  shape.
- **Firebase MCP** (`mcp__plugin_firebase_firebase__*`) for ad-hoc
  inspection — Firestore docs, Auth users, deploy state, function
  logs. Not for production code paths; see "Per-user data model"
  for why the typed callables stay the only client surface.
- **Context7** (`mcp__plugin_context7_context7__*`) for current
  library/framework docs — React, Vite, Firebase SDK, Anthropic
  SDK, Tailwind, etc. Prefer over WebSearch / WebFetch; training
  data lags real releases.

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

## Shipping practices

- **Deploy is gated on lint + test.** `npm run deploy` runs
  `npm run lint && npm test && npm run build && firebase deploy`.
  If lint or tests fail, the deploy aborts. Don't work around this
  by invoking `firebase deploy` directly — fix the failure or back
  out the change.
- **Feature branch + PR for anything non-trivial.** Typo fixes and
  one-line copy tweaks can land on `main`; logic changes, new
  files, prompt edits, dependency bumps go through a branch + PR.
  This is a self-discipline rule, not a server-side gate — GitHub
  doesn't enforce branch protection on free private repos.
  Squash-merge so `main` stays one-commit-per-PR (the existing
  terse commit-message style assumes that shape).
- **CI runs lint, test, SPA build, and functions build on every PR
  and push to `main`** (`.github/workflows/ci.yml`). Red CI on a
  PR means don't merge; red CI on `main` means revert or fix
  forward immediately. Don't disable a check to make it pass —
  fix the underlying problem or back out the change. CI never
  deploys; deploys stay manual.
- **Lazy migration at the read boundary, not migration scripts.**
  When a Firestore document shape changes (candidate model, session
  model, prompt config), handle old data in the read path. The
  `'shortlist'` → `'pending'` sanitizer in
  `functions/src/sessions.ts` is the canonical example. Reasons:
  the data set is one user, lazy migration is simpler to reason
  about, and the sanitizer doubles as documentation of what
  changed. Don't write one-off backfill scripts.
- **Dependabot opens weekly bumps** for root npm, `functions/`
  npm, and `github-actions` (`.github/dependabot.yml`). PRs flow
  through CI so a breaking bump fails loudly before merge.

## Testing as we go

The testable surface (pure helpers, resolver, executor with mocked
deps, hooks) is defined in the architecture-philosophy section
above. These rules govern how the suite grows over time:

- **Every bug fix ships with the regression test that would have
  caught it.** Build the suite along actual failure lines, not
  imagined ones. The test goes in the same PR as the fix.
- **Test against the shared layer when two paths converge.** AI
  and UI both compile to `Assignment[]` and feed the resolver —
  the test goes against the resolver, not against
  `compileAiAssignments` and `compileDndAssignments` separately.
  Corollary to "prefer breaking both paths with the same bug."
- **Mock at the client boundary, not over the wire.** No tests
  against real PCO or real Anthropic. `PcoClient` and `AiProvider`
  are the mocking seams. Network tests are flaky, slow, and burn
  rate-limit budget for no real coverage gain at this scale.
- **AI prompt-structure changes get a regression test.** When you
  touch `prompts.ts`, `buildUserMessage`, or `renderCandidates`,
  pin the structural shape (blocks present, order, cache-
  breakpoint position) for a known input. Not a brittle snapshot
  — a structural assertion. AI prompt regressions are uniquely
  expensive: token bloat, cache misses, or weird tool calls don't
  fail loudly, they just degrade silently.

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
  just added noise. The `frontend-design` skill defaults to
  distinctive, AI-flavored aesthetics — when using it on this repo,
  this rule overrides those defaults.
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
  reject. The timer's callback only fires the AI turn if
  `unservedRejectsRef >= 2` — a single click-only reject doesn't
  trigger a chat turn. When it fires, it routes through
  `handleSuggest({ autoRefresh: true })`, which appends a
  `↻ Auto-refining…` system marker (no synthetic user-prose turn)
  and passes `autoRefresh: true` to the AI so the prompt switches
  into terse mode (commits/clears are disallowed during auto-refresh;
  the SPA also drops them as belt-and-suspenders).
- **Slot-state ops flow through one path: `compile* → resolvePlan
  → executePlan`.** Both UI events (DnD drops, button clicks,
  popover picks) and AI tool calls (`set_slot_contents`) compile to
  the same `Assignment[]` shape (`{slotIndex, song: {id, title} |
  null}`), feed the same pure resolver
  (`src/lib/planActions/resolver.ts`), and apply through the same
  executor (`src/lib/planActions/executor.ts`). The executor handles:
  optimistic items state, two-phase PCO writes (clears before
  commits — Phase 1 clears all sources, Phase 2 commits all targets,
  deduped when a slot is both), rollback on failure, chat-message
  synthesis (`messages.ts`), and the post-turn refresh. AI passes
  `deferRefresh: true` so a single refresh fires after the whole
  stream rather than per-action. The AI tool surface still uses
  `{slotIndex, candidateId}`; `translateAiAssignments` (in
  `aiTranslate.ts`) bridges to the resolver's song-ref shape.
- **Decision: `'pending' | 'reject'` only.** The shortlist
  intermediate state was removed; candidates are either active or
  rejected. "Is this candidate currently committed?" is *derived*
  from `items.songId === candidate.song?.id` — never stored on the
  candidate. (See the architecture philosophy section.) Sessions
  persisted before this change collapse old `'shortlist'` values to
  `'pending'` via the sanitizer in `functions/src/sessions.ts`.
- **Reject is boolean — no per-candidate metadata.** Rejecting a song
  flips `decision` to `'reject'` and that's it. There's no reason
  field, no chip pool, no rationale picker. Course-correction belongs
  in the chat input (volatile, per-turn) or per-plan notes (stable,
  cached). Don't reintroduce reasons in any form (chips, freeform,
  classifier output) — see `feedback_no_reject_reasons.md` for
  the rationale: per-candidate reasons risk overgeneralizing one
  rejection's framing onto unrelated songs. The `remove_candidates`
  tool likewise takes only `ids`; the AI's prose reply is where it
  explains its actions.
- **Per-turn context compaction.** Three patterns reduce per-turn
  token count regardless of cache state: (1) candidates the AI saw
  on a prior turn drop their `chorusSnippet` from subsequent payloads
  via `lastSentCandidateIdsRef`; (2) `renderCandidates` in
  `functions/src/ai/userMessage.ts` stratifies output by decision —
  committed candidates render as just `id, title, author, →slot N`
  (the service order already shows everything else about them);
  rejected as `id, title, author, rejected`; only pending candidates
  get the full render (inLibrary flag, slot tags, chorus, earmark);
  (3) chat history beyond `HISTORY_PROSE_CAP` (8 prose messages)
  drops old prose entirely and collapses old `[event]` system
  messages into one `[summary]` line of category counts at the top
  of history. See `buildAiHistory` and `summarizeOldEvents`.
  **`author` always goes through on every candidate** regardless of
  decision or known-to-AI status — worship song titles are often
  ambiguous and the disambiguator is load-bearing.

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
  Phase 6 made this concrete: per-candidate `priorSlotTitle` was
  removed entirely (it was the worst-case stored state — accumulated
  taint across overwrites). The only restore-title sources now are
  the server-persisted `slotPlaceholders` map (refreshed on every
  load) and the position-based `fallbackSlotTitle` ("Song N").
  Losing a custom slot name to "Song N" is better than restoring
  a stale song name.
