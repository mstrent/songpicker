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

## AI provider preference

- Default: **Anthropic Claude Sonnet 4.6** (`AI_PROVIDER=anthropic`).
- Gemini's free tier is denied to Google Workspace accounts (the
  account that pays for Firebase) — `limit: 0` on the free-tier
  metric, 403 on premium models. Don't propose Gemini as a free path
  for Workspace users.
- Each provider's `suggestSongs` returns a shared `debug` shape via
  `buildUserMessage` so the SPA's debug panel always reflects what
  was actually sent.

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
  (`ALLOWED_EMAIL`, `AI_PROVIDER`, `ADMIN_EMAILS`,
  `INCLUDED_SERVICE_TYPES`). Pushes to prod on `npm run deploy`.
- `functions/.secret.local` for emulator-time secret values
  (`PCO_APP_ID`, `PCO_SECRET`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`).
  Bootstrap from prod with
  `firebase functions:secrets:access <NAME>`. Gitignored.

## SPA patterns

- Hash-based routing in `App.tsx` — no router library. Routes:
  `#` (plan list), `#plan/<serviceTypeId>/<planId>` (detail),
  `#admin`.
- Per-plan editable fields (theme + service-notes) auto-save 600ms
  after the last keystroke (`userTouchedTheme` / `userTouchedNotes`
  refs guard the initial seed). Reset buttons clear the override
  immediately. Saving an empty string is the "no override" sentinel.
- Every UI element whose content goes to the AI carries a `✨`
  `ai-context-marker` icon (gradient-clipped sparkle) with an
  explanatory tooltip. The AI moments (Suggest button, AI candidates
  heading, prompt editors) use the shared `--ai-gradient` and the
  twinkling `.sparkle` animation. Keep this consistent.

## Feedback rules picked up so far

- **Don't auto-migrate or auto-strip user data.** Matt rejected a
  loadUserNotes prefix-stripper because the right answer was a Reset
  button, not silently rewriting saved content.
- **Discuss substantive design choices in prose before issuing
  AskUserQuestion.** Matt's already-saved feedback in memory — and
  visible in his early-conversation pattern — confirms it.
