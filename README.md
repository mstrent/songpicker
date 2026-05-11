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

- **Frontend**: React + Vite SPA
- **Hosting**: Firebase Hosting
- **Backend**: Firebase Cloud Functions (keeps PCO and AI keys server-side)
- **Database**: Firestore (per-plan sessions, candidate pool, AI turn log, prompt presets)
- **Auth**: Firebase Auth — Google sign-in, single-user whitelist
- **AI**: provider-agnostic (Anthropic Claude + OpenAI), switchable via env var
- **Planning Center**: Services API v2 with a Personal Access Token

All hosted on Firebase free tier.

## Planning Center API touchpoints

| Endpoint | Use |
| --- | --- |
| `GET /service_types` | List service types |
| `GET /service_types/{id}/plans` | List upcoming plans |
| `GET /service_types/{id}/plans/{id}` | Plan title, series, sort_date |
| `GET /service_types/{id}/plans/{id}/notes` | Read sermon theme / scripture from plan notes |
| `GET /songs` | Search song library; returns `last_scheduled_at`, `themes`, `ccli_number`, etc. |
| `POST /service_types/{id}/plans/{id}/items` | Insert each chosen song into the plan order |

Docs: <https://api.planningcenteronline.com/docs>

## Local setup

> Requires Node 20+. Install via [nvm](https://github.com/nvm-sh/nvm) if you don't have it.

```bash
git clone git@github.com:mstrent/songpicker.git
cd songpicker
cp .env.example .env.local   # fill in PCO + Firebase + AI keys
npm install
npm run dev
```

## Status

Early — repo just initialized. Scaffold to follow.
