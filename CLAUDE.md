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
technical JSON-format instructions (`TECHNICAL_REQUIREMENTS`) are
concatenated to the resolved role before being sent as the model's
system message — never surfaced to users via the persona editor, only
visible read-only on the Admin page.

## AI provider

- Anthropic Claude Sonnet 4.6, via `@anthropic-ai/sdk`. Single
  provider — we used to abstract over Gemini and OpenAI too, but
  trimmed those out. The `AiProvider` interface in
  `functions/src/ai/types.ts` is kept so a future provider can slot
  in, but `getAiProvider()` just returns `AnthropicProvider`.
- `suggestSongs` returns a `debug` payload via `buildUserMessage` so
  the SPA's debug panel always reflects what was actually sent.

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
  batch into a single render with consistent state. See
  `commitCandidate`, `moveSongToEmptySlot`, `swapTwoFilledSlots`
  in `PlanDetail.tsx` for the pattern.
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
- **Auto-replacement skips when the list is at/over `maxCount`.**
  Refining adds candidates without removing old ones, so the list
  can grow past the requested max. `scheduleReplacement` reads
  `candidatesRef.current` and `maxCountRef.current` (mirrored via
  effects to avoid stale-closure inside the 600ms-delayed timer)
  and bails when active count is already at the cap.

## Feedback rules picked up so far

- **Don't auto-migrate or auto-strip user data.** Matt rejected a
  loadUserNotes prefix-stripper because the right answer was a Reset
  button, not silently rewriting saved content.
- **Discuss substantive design choices in prose before issuing
  AskUserQuestion.** Matt's already-saved feedback in memory — and
  visible in his early-conversation pattern — confirms it.
