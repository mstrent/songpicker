# Login and Usage Metrics — Design

Status: draft
Date: 2026-05-14

## Goal

Give the admin (Matt) an in-app view of who is using songpicker and
what they're doing at a high level. Answer two questions at a glance:

1. **Who is using it, and when did they last sign in?**
2. **What are they doing — sign-ins, plan opens, AI suggestions, slot edits?**

Out of scope: per-event timelines, funnels, retention curves,
external analytics services, client-side instrumentation beyond a
single sign-in ping.

## Architecture

A new `functions/src/metrics.ts` module exposes a single helper
`recordMetric(uid, email, action)` that increments a per-user
counter doc in Firestore. Existing callables in `index.ts` that we
want to count add one line after their existing `requireAllowed`
gate. A new thin callable `recordSignIn` is fired once from the SPA
on Firebase Auth state change. A new admin-only callable
`getMetrics` returns all roll-ups for an Admin page section.

No client-side instrumentation library, no external analytics
service, no event subcollection.

### Data flow

```
SPA onAuthStateChanged → recordSignIn callable → recordMetric(uid, email, 'signIns')
                                                        │
existing callables (getPlanContext, suggestSongs, …) ───┤
                                                        ▼
                                       Firestore: metrics/{uid}

AdminPage → getMetrics callable → loadAllMetrics() → metrics/* (admin SDK read)
```

## Data model

One Firestore collection, admin-SDK-only (clients never read or
write directly, per CLAUDE.md's "Per-user data model" pattern).

`metrics/{uid}`:

```ts
interface UserMetrics {
  email: string          // mirrored for display; refreshed on every write
  firstSeenAt: Timestamp // serverTimestamp on first ever write
  lastSeenAt: Timestamp  // serverTimestamp on every recordMetric
  signIns: number        // recordSignIn only
  plansOpened: number    // getPlanContext
  aiSuggestions: number  // suggestSongs
  slotCommits: number    // placeSongInSlot
  slotClears: number     // clearSongFromSlot
}
```

Counter names map 1:1 to the actions tracked. Writes use
`FieldValue.increment(1)` plus a merged `lastSeenAt` +
`email`. `firstSeenAt` is set only when the doc doesn't already
exist — implemented as a doc read at the top of `recordMetric`
and a branch on existence (cheap; reads in our usage are
effectively free). Counters left undefined by `increment(1)`
are treated as 0 by Firestore, so no explicit zero-init is needed
for the unbumped fields on a fresh doc.

## Components

### Server

`functions/src/metrics.ts`:

- `MetricAction` — union type `'signIns' | 'plansOpened' |
  'aiSuggestions' | 'slotCommits' | 'slotClears'`.
- `recordMetric(uid: string, email: string, action: MetricAction):
  Promise<void>` — increments the counter, refreshes `lastSeenAt`,
  mirrors `email`. Creates the doc with `firstSeenAt` if missing.
  Wrapped in try/catch; logs failures via `console.warn` and
  resolves without throwing.
- `loadAllMetrics(): Promise<UserMetricsView[]>` — admin-page read.
  Returns docs sorted by `lastSeenAt` desc. `UserMetricsView`
  serializes the two `Timestamp` fields to ISO strings for the
  callable response.

`functions/src/index.ts`:

- New `export const recordSignIn = onCall(...)` — `requireAllowed`,
  then `recordMetric(uid, email, 'signIns')`.
- New `export const getMetrics = onCall(...)` — `requireAdmin`,
  returns `{ users: UserMetricsView[] }`.
- Five existing callables each get one new line after
  `requireAllowed`:
  - `getPlanContext` → `recordMetric(uid, email, 'plansOpened')`
  - `suggestSongs` → `recordMetric(uid, email, 'aiSuggestions')`
  - `placeSongInSlot` → `recordMetric(uid, email, 'slotCommits')`
  - `clearSongFromSlot` → `recordMetric(uid, email, 'slotClears')`
  - (`recordSignIn` covers the fifth.)

The added lines are `void recordMetric(...)` — fire-and-forget,
since the helper already swallows errors and we don't want to
serialize the user's response on the metric write.

### Client

`src/lib/api.ts`:

- Add typed clients `recordSignIn` and `getMetrics` alongside the
  existing ones.

`src/App.tsx`:

- Inside the existing `onAuthStateChanged` effect, fire-and-forget
  `recordSignIn()` once per transition from null/undefined → signed-in.
  Guarded by a ref (`recordedForUidRef`) so React StrictMode's
  double-invoke and same-user re-renders don't double-count. Errors
  caught with `.catch(() => {})`.

`src/components/AdminPage.tsx`:

- New `MetricsSection` component placed above the Access lists.
- Fetch via `getMetrics()` on mount; matches the `AccessSection`
  loading + error patterns.
- Renders a table with columns: Email · Sign-ins · Plans opened ·
  AI suggestions · Commits · Clears · First seen · Last seen.
- `lastSeenAt` formatted as a relative string ("2h ago", "yesterday")
  using a small inline helper. Absolute date as `title` on hover.
- Empty state: "No activity recorded yet." when the user list is empty.

## Error handling

- **Metric write failures never propagate.** `recordMetric` is
  wrapped in try/catch and logs `[metrics] write failed: <err>`.
  The calling callable continues — a flaky metric write must never
  break a plan open or an AI suggestion.
- **`recordSignIn` failures are silent on the client.** Fired with
  `.catch(() => {})`. Not worth a user-visible error; the next
  callable will refresh `lastSeenAt` anyway.
- **`getMetrics` failures** surface as an inline error banner inside
  `MetricsSection`, matching the `AccessSection` pattern.
- **Empty state** rendered explicitly rather than as an empty table.

## Testing

Per CLAUDE.md's testable-surface rule (pure helpers + seams, not
rendered DOM):

- `functions/src/metrics.test.ts` against the Firestore emulator:
  - First write creates doc with `firstSeenAt` and the right
    counter at 1, others at 0.
  - Second write increments the targeted counter and refreshes
    `lastSeenAt`; doesn't change `firstSeenAt`.
  - A write that throws (forced via a mock) is swallowed — the
    promise resolves, `console.warn` is called.
- One integration test on the callable wiring: invoking
  `getPlanContext` via the emulator increments `plansOpened`.
  Verifies the pattern works; the per-callable additions are
  one-liners and visible in review.
- No prompt-structure regression test needed — this doesn't touch
  AI prompts.

The client sign-in firing is a one-liner in an existing effect;
not worth a test.

## Asymmetries (deliberate)

- **Sign-in count is client-fired; the other four are server-fired.**
  Sign-ins have no server-side event to hang a count off (the user
  signing in doesn't necessarily trigger a callable immediately, and
  conflating "opened the app" with "any callable hit" would inflate
  the number). All four content actions ride on existing callables.
- **`recordMetric` is fire-and-forget on the server, awaited on the
  test.** Production paths shouldn't pay latency for a counter
  bump; tests need the await to observe the write.

## Open questions

None — all design choices are settled.

## Out of scope (explicit)

- Per-event timeline / event log subcollection.
- External analytics (GA, Mixpanel, PostHog).
- Retention windows / TTL on the metric docs — single-doc-per-user
  storage is bounded by the user count, which is small.
- Per-plan or per-song breakdowns.
- Daily / weekly time-series charts.
- Export to CSV.
