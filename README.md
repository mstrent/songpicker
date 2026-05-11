# songpicker

A personal worship song picker for service planning. Pulls upcoming service themes from Planning Center, generates AI song suggestions that fit the theme + criteria, lets you iterate on a candidate pool, then commits a final ordered set list back to Planning Center.

## How it works

1. Pick the upcoming plan from Planning Center → app pulls title, series, and plan notes (theme).
2. Edit criteria (mood, tempo, era, must-include themes, things to avoid) and click **Suggest songs**.
3. AI returns candidates → app auto-looks each one up in your PCO song library and annotates with `last_scheduled_at` + an "exists in library" badge.
4. Iterate: shortlist / reject, ask for "more like this but slower", manually add a song you remembered.
5. Drag the shortlist into the order you want.
6. **Commit to Planning Center** → posts items into the plan in the chosen order.

AI iteration is stateful but not conversational — each regeneration receives the full session context (criteria + current candidate pool + what was rejected) so it improves without you re-explaining.

## Stack

- **Frontend**: React + Vite SPA (TypeScript)
- **Hosting**: Firebase Hosting
- **Backend**: Firebase Cloud Functions (Gen 2, TypeScript) — keeps PCO and AI keys server-side
- **Database**: Firestore — per-plan sessions, candidate pool, AI turn log, prompt presets
- **Auth**: Firebase Auth — Google sign-in with single-email allowlist
- **AI**: provider-agnostic (Anthropic Claude Sonnet 4.6 + OpenAI GPT-4o), switchable via `AI_PROVIDER` param
- **Planning Center**: Services API v2 with a Personal Access Token

All hosted on Firebase free tier.

## Repo layout

```
.
├── src/                  React SPA (Vite)
│   ├── App.tsx           Auth gate + main shell
│   ├── components/       SignIn, PlanList, ...
│   ├── lib/              firebase, auth, api (typed callable wrappers)
│   └── config.ts         Vite env vars
├── functions/            Cloud Functions (TypeScript, Gen 2)
│   └── src/
│       ├── index.ts      Callable functions: listPlans, getPlanContext,
│       │                 searchSongs, suggestSongs, commitPlanItems
│       ├── pco/          PCO API client (no SDK, plain fetch)
│       └── ai/           Provider-agnostic AI (anthropic, openai)
├── firebase.json         Hosting + Functions + Firestore + Emulators config
├── firestore.rules       Per-doc owner-email gate
├── .firebaserc           Firebase project ID (set this)
├── .env.example          Client env template (copy to .env.local)
└── .mcp.json             Project-local Firebase MCP for Claude Code
```

## Planning Center API touchpoints

| Endpoint | Use |
| --- | --- |
| `GET /service_types` | List service types |
| `GET /service_types/{id}/plans?filter=future` | List upcoming plans |
| `GET /service_types/{id}/plans/{id}/notes?include=plan_note_category` | Read theme/scripture notes |
| `GET /songs?where[title]=...` | Search song library; returns `last_scheduled_at`, `themes`, `ccli_number` |
| `POST /service_types/{id}/plans/{id}/items` | Insert a song into the plan order |

PCO docs: <https://api.planningcenteronline.com/docs>

## First-time setup

> Requires Node 20+ (install via [nvm](https://github.com/nvm-sh/nvm) if needed) and the Firebase CLI (`npm install -g firebase-tools`).

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

### 3. Cloud Functions secrets

Get a Personal Access Token from <https://api.planningcenteronline.com/oauth/applications> (the bottom "Personal Access Tokens" section). It comes as `application_id:secret`.

```bash
firebase functions:secrets:set PCO_APP_ID
firebase functions:secrets:set PCO_SECRET
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set OPENAI_API_KEY
```

Set non-secret params for the Functions runtime in `functions/.env`:

```
ALLOWED_EMAIL=you@example.com
AI_PROVIDER=anthropic
```

### 4. Install

```bash
npm install
npm --prefix functions install
```

### 5. Local development

Three terminals — fast iteration without redeploying:

```bash
npm run dev               # Vite SPA on http://localhost:5173
npm run dev:functions     # tsc --watch on Cloud Functions
npm run dev:emulators     # Firebase emulators (functions + firestore)
```

Auth stays against the real Firebase project so Google sign-in works
locally. Functions and Firestore run in the emulator suite.

The Functions emulator reads secrets from `functions/.secret.local`.
Bootstrap that file once:

```bash
cp functions/.secret.local.example functions/.secret.local
firebase functions:secrets:access PCO_APP_ID    # paste output into the file
firebase functions:secrets:access PCO_SECRET
firebase functions:secrets:access GEMINI_API_KEY
```

`.env.development` automatically sets `VITE_USE_EMULATORS=true` for
`vite dev`, so SPA-side wiring just works.

### 6. Deploy

```bash
npm run deploy                       # builds SPA + deploys hosting + functions + firestore rules
```

## Status

Scaffold complete; v1 slice (sign in → list upcoming plans) is wired end-to-end. Candidate-pool UI, drag-to-reorder, and commit flow are next.
