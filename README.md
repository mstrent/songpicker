# songpicker

A personal worship song picker for service planning. Pulls upcoming
service themes from Planning Center, generates AI song suggestions
that fit the theme + criteria, lets you iterate on a candidate pool,
and commits picks back into the existing Planning Center plan slots —
title, arrangement, and key all set in one go.

## How it works

1. Sign in with Google. First run: paste a Planning Center Personal
   Access Token into the in-app setup screen. It's stored per-user in
   an admin-SDK-only Firestore document; the SPA never reads it back.
2. Pick an upcoming plan from the list. The detail view pulls the
   plan's title, series, dated notes, current item order, assigned
   song leaders, and the existing song slots ("Song 1", "Opening
   song", etc.).
3. Optionally tweak the per-plan **theme** and **service notes** in
   place — they auto-save and feed the AI prompt. Persona and
   service-flow prompts have their own per-plan overrides too,
   resolved through three tiers (per-plan → user default →
   admin global → hardcoded fallback).
4. Click **Suggest songs**. The AI returns candidates; each is
   auto-looked-up in your Planning Center song library and annotated
   with `last_scheduled_at`. Songs played within the last four weeks
   get a caution highlight.
5. Iterate in a chat-style conversation: reject songs (with an
   optional reason — picked from a global chip pool or freeform),
   ask the AI to "give me a few slower options for the closer" or
   "swap A and B" or "commit X to slot 2", and the AI takes action
   directly. It can propose, retire, commit, clear, move, and swap
   via tool calls; manual drag-and-drop still works in parallel.
6. Drag candidates onto empty song slots in the plan, or drag between
   filled slots to swap. Committing a candidate:
   - PATCHes the plan item's title to the song's name
   - links the song relationship
   - lets you pick the arrangement + key (writes the Key resource id
     onto the item)
   Clearing a slot restores its prior title (with taint detection
   so a slot that's been through multiple swaps doesn't end up
   labelled with a previous song).

## Stack

- **Frontend**: React + Vite SPA (TypeScript), hash-based routing,
  HTML5 drag-and-drop with a custom drag ghost.
- **Hosting**: Firebase Hosting.
- **Backend**: Firebase Cloud Functions (Gen 2, TypeScript, Node 22)
  — keeps PCO and AI keys server-side.
- **Database**: Firestore — per-user PCO credentials, per-user prompt
  config (defaults + per-plan overrides), admin-global prompt
  defaults, and per-plan candidate sessions.
- **Auth**: Firebase Auth — Google sign-in with single-email allowlist
  enforced both client-side (Firestore rules) and server-side
  (`ALLOWED_EMAIL` param in Cloud Functions).
- **AI**: Anthropic Claude Sonnet 4.6 for the main suggestion engine,
  Haiku 4.5 for ancillary classifier/short-label calls (chip matching
  and distillation). The `AiProvider` interface in
  `functions/src/ai/types.ts` is kept so another provider can slot in
  later, but only Anthropic is wired up today.
- **Planning Center**: Services API v2 with a per-user Personal
  Access Token.

All hosted on Firebase free tier.

## Repo layout

```
.
├── src/                       React SPA (Vite)
│   ├── App.tsx                Auth gate + hash router (#, #plan/.., #admin)
│   ├── components/
│   │   ├── SignIn.tsx
│   │   ├── PcoSetup.tsx               First-run PCO token entry
│   │   ├── PlanList.tsx
│   │   ├── PlanDetail.tsx             Per-plan workflow + DnD
│   │   ├── ArrangementKeyEditor.tsx
│   │   ├── PromptPill.tsx / PromptBody.tsx
│   │   └── AdminPage.tsx              Global prompt defaults
│   ├── lib/                   firebase, auth, typed callable wrappers,
│   │                          per-session cache, song-slot heuristics,
│   │                          search-link helpers, prompt-config hook
│   └── config.ts              Vite env vars
├── functions/                 Cloud Functions (TypeScript, Gen 2, Node 22)
│   └── src/
│       ├── index.ts           All callable functions (see below)
│       ├── config.ts          defineSecret / defineString params
│       ├── prompts.ts         Hardcoded default persona + service-flow
│       ├── sessions.ts        Per-plan candidate-pool persistence
│       ├── pco/               PCO API client (plain fetch, no SDK):
│       │                      client, credentials, concurrency (rate-
│       │                      limited pMap), song-slot heuristics, types
│       └── ai/                Anthropic provider + shared types +
│                              buildUserMessage (AiProvider abstraction
│                              kept for future swap-in)
├── firebase.json              Hosting + Functions + Firestore + Emulators
├── firestore.rules            Owner-email gate; admin-SDK-only docs
├── firestore.indexes.json
├── .firebaserc                Firebase project ID (set this)
├── .env.example               Client env template (copy to .env.local)
├── .nvmrc                     Node 22
├── .mcp.json                  Project-local Firebase MCP for Claude Code
└── CLAUDE.md                  Conventions + PCO/SPA gotchas for AI agents
```

### Callable functions (functions/src/index.ts)

| Function | Use |
| --- | --- |
| `getPcoStatus`, `savePcoCredentials` | Per-user PCO token setup |
| `listPlans`, `getPlanContext` | Plan list + detail (notes, items, leaders) |
| `savePlanTheme`, `savePlanNotes` | Auto-saved per-plan overrides |
| `searchSongs` | Song-library lookup (with parenthetical-stripped retry) |
| `suggestSongs` | Streaming AI turn (Claude Sonnet 4.6 + tool use); SPA calls via `.stream()` |
| `getPromptConfig`, `savePromptConfig` | Per-user persona + service-flow prompts |
| `getAdminStatus`, `getAdminPromptConfig`, `saveAdminPromptConfig` | Admin global defaults |
| `loadSession`, `saveSession` | Per-plan candidate pool + AI turn log |
| `placeSongInSlot` | Commit a song to a slot (handles fresh, move, and overwrite atomically) |
| `clearSongFromSlot` | Clear a slot (restores a prior title) |
| `listSongArrangements`, `setSlotArrangementKey` | Arrangement + key picker |
| `reorderItems` | Whole-plan item reorder via the dedicated PCO action endpoint |
| `getRejectionReasons`, `recordRejectReason`, `removeCommonReason`, `renameCommonReason` | Global reject-rationale chip pool: three-tier resolution (norm match → Haiku semantic match → Haiku per-reason distill into a new chip) |
| `commitPlanItems` | Bulk insert (used by the older candidate-list flow) |

## Planning Center API touchpoints

| Endpoint | Use |
| --- | --- |
| `GET /service_types` | List service types (filtered by `INCLUDED_SERVICE_TYPES`) |
| `GET /service_types/{id}/plans?filter=future` | Upcoming plans |
| `GET /service_types/{id}/plans/{id}` (`?include=items,plan_times`) | Plan detail + items |
| `GET /service_types/{id}/plans/{id}/notes?include=plan_note_category` | Theme / scripture notes |
| `GET /items/{id}/item_assignments?include=item_assignments.assignable` | Song leaders (Person or TeamPosition) |
| `GET /songs?where[title]=...` | Song lookup (`?q=` and `title_like` are silently broken) |
| `GET /songs/{id}/arrangements?include=keys` | Arrangement + Key resources |
| `PATCH /service_types/{stid}/plans/{pid}/items/{iid}` | Set item title + song + key relationships |
| `POST /service_types/{stid}/plans/{pid}/item_reorder` | Reorder the whole plan in one call |

PCO docs: <https://api.planningcenteronline.com/docs>

See `CLAUDE.md` for the non-obvious gotchas (broken search params,
unreliable `item_type`, the rate-limit story, the read-only `sequence`
attribute, the `relationships.key` write path, etc.).

## First-time setup

> Requires Node 22 (install via [nvm](https://github.com/nvm-sh/nvm);
> `nvm use` picks it up from `.nvmrc`) and the Firebase CLI
> (`npm install -g firebase-tools`).

### 1. Firebase project

```bash
firebase login
firebase projects:create songpicker-yourname   # or use an existing project
firebase use --add                             # writes your project ID into .firebaserc
```

In the [Firebase Console](https://console.firebase.google.com/):
- **Authentication** → enable **Google** sign-in provider.
- **Firestore Database** → create database (production mode).
- **Project Settings** → **Your apps** → add a Web app and copy the config.

### 2. Client environment

```bash
cp .env.example .env.local
# fill in VITE_FIREBASE_* from Firebase Console + your VITE_ALLOWED_EMAIL
```

### 3. Cloud Functions params + secrets

Set the non-secret params for the Functions runtime in `functions/.env`:

```
ALLOWED_EMAIL=you@example.com
ADMIN_EMAILS=you@example.com           # comma-separated; empty disables /#admin
INCLUDED_SERVICE_TYPES=Sunday Services # comma-separated; empty = include all
```

Set the Anthropic API key:

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
```

> **Planning Center credentials are per-user, not global.** After
> signing in, the SPA prompts each user for a Personal Access Token
> from <https://api.planningcenteronline.com/oauth/applications>
> (bottom of the page, **Personal Access Tokens**). The token is
> stored in Firestore at `pcoCredentials/{uid}` under admin-SDK-only
> rules — Cloud Functions read it on the user's behalf; clients can't.
> There is no `PCO_APP_ID` / `PCO_SECRET` secret to set.

### 4. Install

```bash
npm install
npm --prefix functions install
```

### 5. Local development

One terminal — runs Vite, the Functions TS watcher, and the Firebase
emulators side by side with prefixed/colorized output:

```bash
nvm use         # picks Node 22 from .nvmrc
npm run dev     # vite + tsc --watch + emulators
```

Ctrl-C kills all three — wait for "export complete" before mashing
it again, or you'll corrupt the emulator export. Individual
processes are also available as `npm run dev:vite`,
`npm run dev:functions`, `npm run dev:emulators`.

Auth stays against the real Firebase project so Google sign-in works
locally. Functions and Firestore run in the emulator suite, with
state persisted to `.emulator-data/` via import + export-on-exit.

The Functions emulator reads secrets from `functions/.secret.local`
(gitignored). Bootstrap once from your deployed secrets:

```bash
cp functions/.secret.local.example functions/.secret.local
firebase functions:secrets:access ANTHROPIC_API_KEY   # paste into the file
# (and any other provider keys you set in step 3)
```

`.env.development` automatically sets `VITE_USE_EMULATORS=true` for
`vite dev`, so SPA-side wiring just works.

### 6. Deploy

```bash
npm run deploy                       # builds SPA + deploys hosting + functions + firestore rules
```
