# Unification refactor — plan

> **Status (May 2026):** in progress. Phases will be checked off as
> they land. See git log for the actual commits.

## Goal

One vocabulary, one resolver, one executor for slot-state changes.
Both the AI tool path (`set_slot_contents`) and the SPA UI (DnD, button
clicks, popover picks) compile their intent into the same shape and
flow through the same code. Bug-fix surface shrinks from N parallel
implementations to 1. Tests cover the pure resolver and the executor.

The animating principle: **prefer breaking both paths with the same
bug**. If we have parallel implementations of "place a song in a
slot," we will eventually drift them. We've already lived this — the
eviction logic existed in the AI path for months before it was
back-ported to the UI's `placeSongAction`; restore-title resolution
had to be threaded through five sites and one was repeatedly missed;
DnD swap and AI swap produce different placeholder outcomes because
they use different PCO endpoints. The cure is one path.

## What gets unified

The set of "slot-state" actions: commit, clear, move, swap, overwrite,
multi-slot rearrangement. These are exactly what `set_slot_contents`
already covers on the AI side. Promote that vocabulary —
`assignments: [{slotIndex, candidateId|null}]` — to the universal
intent language.

What stays separate (different resource):

- `propose_songs` / manual add — operates on candidate pool, not
  slot state.
- `remove_candidates` / reject toggle — operates on candidate
  decision state. Will share its own unified path
  (`applyDecisionChange`) but doesn't fold into slot-state.

## Architecture

```
       ┌────────────────────────┐         ┌────────────────────────┐
       │  AI tool call          │         │  UI event              │
       │  set_slot_contents     │         │  (DnD drop, button)    │
       └────────────┬───────────┘         └────────────┬───────────┘
                    │                                  │
                    │ assignments[]                    │ compileAssignments(event)
                    ▼                                  ▼
          ┌────────────────────────────────────────────────────────┐
          │  resolvePlan(assignments, state)  — pure function      │
          │  • detect swap pairs → reorder                         │
          │  • compute eviction targets                            │
          │  • resolve restore titles (placeholder priority)       │
          │  • resolve placeholder swaps                           │
          │  • emit Plan: ordered ops + state diffs + message       │
          └────────────────────────┬───────────────────────────────┘
                                   ▼
          ┌────────────────────────────────────────────────────────┐
          │  executePlan(plan)  — side-effects                     │
          │  • apply optimistic state updates                      │
          │  • fire PCO calls in correct order                     │
          │  • refresh items + slotPlaceholders on completion      │
          │  • rollback on failure                                 │
          │  • emit chat message                                   │
          └────────────────────────────────────────────────────────┘
```

Both AI and UI paths hand the resolver the same shape. The resolver is
a pure function we can test exhaustively. The executor is the only
place that talks to PCO + mutates SPA state + writes to the chat log.

## Testing philosophy

- **Pure functions get unit tests.** Helpers (`resolveRestoreTitle`,
  `findEvictionTarget`, `placeholderForSlot`, `detectSwapPairs`,
  `compileAssignmentsFromDnD`) and the resolver are all pure. They
  take inputs, return outputs, no I/O. Vitest, in-process, fast.
- **Stateful orchestration goes through a hook (`usePlanState`).** The
  hook is the seam: render-layer above, state + action layer below.
  Tested by driving it with mock callable responses and asserting on
  returned state.
- **Don't unit-test the rendered UI for state correctness.** That
  conflates rendering bugs with logic bugs and slows the test loop.
  Render tests stay focused on render concerns.

## Phases

Each phase is a small set of commits with a clear behavior contract:
phases 0-2 are no-behavior-change refactors. Phase 3 is the actual
consolidation. Phase 4 extracts the orchestration hook. Phase 5 is
optional perf polish.

### Phase 0 — Test infrastructure + pure helpers

- Set up Vitest config + npm script.
- Extract pure helpers from PlanDetail into `src/lib/planActions/`:
  - `resolveRestoreTitle(slot, candidates, slotPlaceholders, candidateForRestore?)`
  - `findEvictionTarget(targetSlot, candidates, excludeId)`
  - `placeholderForSlot(slot, slotPlaceholders, fallbackForSlot)`
  - `isTaintedTitle(title, candidates, items)`
  - `detectSwapPairs(assignments, items, candidates)`
  - `compileAssignmentsFromDnD(event, items, candidates)`
- Extract `refreshPlanState(serviceTypeId, planId, setItems, setSlotPlaceholders)`
  helper — eliminates the 6+ inlined copies.
- Tests for every helper.

**Acceptance:** existing PlanDetail logic uses the helpers (no inline
duplication of these patterns), `npm run test` runs Vitest cleanly,
every helper has at least happy-path + 1 edge-case test, build still
passes, manual smoke test of the SPA shows no behavior change.

### Phase 1 — Pure resolver

- Implement `resolvePlan(assignments, state) → Plan` in
  `src/lib/planActions/resolver.ts`.
- Implement `Plan` type: `{ pcoOps, stateDiffs, message }`.
- Implement `Op` types: `commit | clear | reorder | placeholderSwap`.
- AI path's `applyAction` switches its `set_slot_contents` branch to
  call `resolvePlan` and execute the returned ops with the EXISTING
  AI machinery — i.e., we extract the planning, keep the executing
  inline for now. This is to validate the resolver in isolation
  before touching the executor.
- Tests for resolver: swap-pair detection, eviction, move-with-overwrite,
  restore-title resolution, taint detection, placeholder swap on
  reorder, multi-assignment turns.

**Acceptance:** resolver test suite covers every scenario in the AI
path's existing logic; AI path produces identical PCO calls + state
diffs as before; build passes; manual smoke test of an AI turn shows
no regression.

### Phase 2 — Executor

- Implement `executePlan(plan, deps) → Promise<Result>` in
  `src/lib/planActions/executor.ts`. `deps` includes setCandidates,
  setItems, setSlotPlaceholders, callable wrappers, appendSystemMessage,
  source: 'user' | 'ai'.
- Implement message synthesizer: `synthesizeMessage(plan, source)`
  with the swap-pair detection that reads `[{4,B},{5,A}]` as
  "Swapped X ↔ Y" rather than two commits.
- AI path becomes `assignments → resolvePlan → executePlan`.
  ~300 lines come out of `applyAction`.
- Tests for executor: optimistic state correctness, rollback on PCO
  failure, message synthesis for each plan shape.

**Acceptance:** AI tool turns route through `resolvePlan +
executePlan`; chat messages match prior format; rollback behavior
unchanged; build passes; manual smoke test of AI commit / clear /
swap / move / overwrite all behave as before.

### Phase 3 — UI compiler + decision-change unification

- Implement `compileAssignmentsFromDnD(event, state) → assignments[]`.
- Replace UI call sites:
  - `placeSongAction` → `compile + resolvePlan + executePlan`
  - `clearSlotAction` → same
  - `swapSlotsAction` → same (resolver decides reorder vs paired ops)
  - `reorderSlotItem` → just compiles assignments; no longer a
    branching orchestrator
- Implement `applyDecisionChange(ids, decision, source)`. Replace
  `setDecision('reject'|'pending')` (UI) and `remove_candidates` /
  `unreject_candidates` action handlers (AI) with calls into it.
- Delete the old action functions.
- Tests for the compiler: every DnD scenario compiles to the
  expected assignments shape.

**Acceptance:** zero call sites of the old action functions remain
(except `searchAndAttachSong` which is unrelated); UI behavior
unchanged for every DnD flow + every button + popover; AI behavior
unchanged; chat messages match prior format; build passes; full
manual smoke test pass.

### Phase 4 — `usePlanState` hook

- Move state + actions from `PlanDetail.tsx` into
  `src/lib/planActions/usePlanState.ts` (or `src/hooks/usePlanState.ts`).
- `PlanDetail` becomes presentational: receives state + actions from
  the hook, renders.
- Hook tests: drive with mock callable responses, assert on returned
  state across realistic flows (load → commit → clear → swap →
  reject → suggest → ...).

**Acceptance:** PlanDetail.tsx down to ~1000 lines (target — current
~2900); hook + helpers + resolver + executor are the testable
surface; manual smoke test of every flow passes.

### Phase 6 — PCO/candidate split (data-model unification)

Surfaced during Phase 5 testing: dragging a filled slot whose song
was placed via PCO directly (and therefore has no songpicker
candidate record) onto another filled slot ran a one-way move that
clobbered the target. Root cause: `compileSlotToSlot` keys "is this
slot filled?" off `candidates` instead of `items.songId`, so songs
without candidate records read as empty. The bandaid fix (separate
fallback path doing paired PATCHes) works but is symptom treatment.

The real architectural insight, articulated by Matt: **PCO is the
source of truth for plan state; candidates are songpicker's own
concept that exists to help fill slots.** They're separate domains
that touch only at commit-time. So:

- `committedAt` and `assignedSlotItemId` on candidates are derived
  state, not source. `items.find(it => it.songId === candidate.song?.id)`
  is the answer; storing it on the candidate creates drift.
- The reconciliation effect (which compensates for that drift) goes
  away.
- Slot operations work on song refs — `{songId, songTitle}` —
  pulled from a candidate's matched library song OR straight from
  PCO's items. No special-casing for PCO-direct songs.
- `Assignment` becomes `{slotIndex, song: {id, title} | null}`. The
  resolver derives isMove / eviction by inspecting `items`, not
  `candidates`.
- The compiler stops needing `candidates` entirely.

This makes the PCO/candidate split visible at every layer and
eliminates the bug class.

**Phase 6a** — Switch `Assignment` shape from `candidateId` to song
ref. Update resolver, executor, compile, decisions, tests. The
unified path now works for PCO-direct songs (no fallback needed).

**Phase 6b** — Drop `committedAt`, `assignedSlotItemId`,
`priorSlotTitle` from `CandidateMatch` / `CandidateState` /
`PersistedCandidate`. Delete the reconciliation effect. Session
persistence shrinks. UI derives "committed" status from items
on every render.

**Phase 6c** — Split `usePlanState` into `usePlanData` (PCO mirror
+ slot ops) and `useCandidatePool` (suggestions + AI + decisions +
chat + session). The hook split reflects the data-model split. The
DnD compiler doesn't need a candidate ref to call into slot ops —
it just needs the song ref the candidate is matched to.

**Acceptance:** the immediate swap-with-PCO-direct-song bug is
fixed at the architecture level (no fallback path needed). All UI
and AI flows continue to work. Tests cover the new resolver +
compile shape. PlanDetail composes the two hooks instead of one.

### Phase 5 — Optimizations

- **Bulk searchSongs**: Cloud Function accepts a batch, runs PCO calls
  under `pMap`. AI's `propose` action fires one batched call instead of
  N sequential lookups.
- **Split refresh granularity**: `refreshSlotState()` re-fetches just
  items + slotPlaceholders (not plan / notes / user prompts), used
  after slot writes. `refreshPlanState()` stays as the full reload.
- **Reconciliation effect cleanup**: with the unified executor as the
  only writer of commit state, the defensive reconciliation effect's
  noisy "↺ N slots cleared in PCO" message can fire silently for the
  PCO-web-UI-edit case (still correct, just less chatty).
- **Manual "add candidate" UI** (optional asymmetry fix): if Matt
  wants the ability to type a song and add it as a candidate without
  going through the AI, a small UI calls into the same `propose`
  flow.

**Acceptance:** Each item is independently committable; no flow
regresses; bundle size doesn't grow significantly.

## What we keep

The AI's tool surface and prompt are unchanged throughout. The whole
point of `set_slot_contents` was to fix the AI's reliability with
multi-step intents — that win stays intact regardless of how we
restructure the SPA internals. AI tool descriptions in
`functions/src/ai/anthropic.ts` don't move.

## Out of scope

- Server-side intent execution (Cloud Function takes assignments).
  Considered in option D of the original analysis; not worth the
  added complexity for a single-user app.
- Replacing the `set_slot_contents` declarative-assignment model with
  something else. It's the right shape; we're just sharing it.
- Changing the candidate session persistence layer. Already centralized.
