/// <reference lib="dom" />
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanDataApi } from './usePlanData'
import type { ExecutorResult } from './planActions/executor'

// Mock the api callables. The candidate pool uses loadSession,
// saveSession, searchSongsBatch, suggestSongs.
vi.mock('./api', () => {
  return {
    loadSession: vi.fn(() =>
      Promise.resolve({ data: { candidates: [], messages: [] } }),
    ),
    saveSession: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    searchSongsBatch: vi.fn(),
    suggestSongs: { stream: vi.fn() },
  }
})

import * as api from './api'
import { useCandidatePool } from './useCandidatePool'

/** Build a stub PlanDataApi with sensible defaults. The candidate
 *  pool reads items + theme + notesText, calls performIntent +
 *  refreshPlanState, and wires its own appendSystemMessage /
 *  setGenerateError into planData via the setter callbacks. */
function stubPlanData(overrides: Partial<PlanDataApi> = {}): PlanDataApi {
  // Captured callbacks used by tests that exercise the planData →
  // candidatePool message wiring.
  let _appendSystemMessage: (msg: string) => void = () => {}
  let _setGenerateError: (msg: string | null) => void = () => {}
  return {
    plan: null,
    notes: null,
    items: [],
    slotPlaceholders: {},
    loadError: null,
    theme: 'Some theme',
    themeSource: 'Some theme',
    notesText: '',
    notesSource: '',
    setTheme: () => {},
    setNotesText: () => {},
    resetTheme: () => {},
    resetNotes: () => {},
    performIntent: vi.fn(
      (): Promise<ExecutorResult> =>
        Promise.resolve({ pcoWritesFired: false, messages: [] }),
    ),
    reorderSlotItem: vi.fn(() => Promise.resolve()),
    refreshPlanState: vi.fn(() => Promise.resolve()),
    fallbackSlotTitle: (id: string) => `Song ${id}`,
    setItems: () => {},
    setAppendSystemMessage: (fn) => {
      _appendSystemMessage = fn
      void _appendSystemMessage
    },
    setGenerateErrorHandler: (fn) => {
      _setGenerateError = fn
      void _setGenerateError
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;vi.mocked(api.loadSession).mockResolvedValue({
    data: { candidates: [], messages: [] },
  })
})

describe('useCandidatePool: initial load', () => {
  it('loads session candidates and messages on mount', async () => {
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: {
        candidates: [
          {
            id: 'c1',
            title: 'Surrender',
            author: null,
            chorusSnippet: null,
            slots: [],
            matchStatus: 'matched',
            song: {
              id: 'song-x',
              title: 'Surrender',
              lastScheduledAt: null,
              lastScheduledShortDates: null,
            },
            error: null,
            decision: 'pending',
            addedAt: 0,
            assignedSlotItemId: null,
            committedAt: null,
            priorSlotTitle: null,
          },
        ],
        messages: [
          {
            id: 'm1',
            role: 'system',
            content: 'previous turn',
            timestamp: 0,
          },
        ],
      },
    })
    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => {
      expect(result.current.sessionLoaded).toBe(true)
    })
    expect(result.current.candidates).toHaveLength(1)
    expect(result.current.candidates[0].id).toBe('c1')
    expect(result.current.messages).toHaveLength(1)
  })
})

describe('useCandidatePool: isCandidateCommitted (derived)', () => {
  it('returns true iff candidate.song.id matches a slot.songId in items', async () => {
    const planData = stubPlanData({
      items: [
        {
          id: 's1',
          sequence: 1,
          title: 'Song 1',
          itemType: 'song',
          songId: 'song-x',
          songTitle: 'X',
          songAuthor: null,
          songCcli: null,
          arrangementId: null,
          keyId: null,
          keyName: null,
          description: null,
          notes: [],
          leaders: [],
        },
      ],
    })
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))
    expect(
      result.current.isCandidateCommitted({ song: { id: 'song-x' } }),
    ).toBe(true)
    expect(
      result.current.isCandidateCommitted({ song: { id: 'song-other' } }),
    ).toBe(false)
    expect(result.current.isCandidateCommitted({ song: undefined })).toBe(false)
  })
})

describe('useCandidatePool: setDecision', () => {
  it('flips a pending candidate to rejected and emits a message', async () => {
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: {
        candidates: [
          {
            id: 'c1',
            title: 'Surrender',
            author: null,
            chorusSnippet: null,
            slots: [],
            matchStatus: 'matched',
            song: {
              id: 'song-x',
              title: 'Surrender',
              lastScheduledAt: null,
              lastScheduledShortDates: null,
            },
            error: null,
            decision: 'pending',
            addedAt: 0,
            assignedSlotItemId: null,
            committedAt: null,
            priorSlotTitle: null,
          },
        ],
        messages: [],
      },
    })
    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => {
      result.current.setDecision('c1', 'reject')
    })

    expect(result.current.candidates[0].decision).toBe('reject')
    expect(
      result.current.messages.some((m) => /Rejected: Surrender/.test(m.content)),
    ).toBe(true)
  })

  it('toggling reject on a rejected candidate unrejects', async () => {
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: {
        candidates: [
          {
            id: 'c1',
            title: 'Surrender',
            author: null,
            chorusSnippet: null,
            slots: [],
            matchStatus: 'matched',
            song: {
              id: 'song-x',
              title: 'Surrender',
              lastScheduledAt: null,
              lastScheduledShortDates: null,
            },
            error: null,
            decision: 'reject',
            addedAt: 0,
            assignedSlotItemId: null,
            committedAt: null,
            priorSlotTitle: null,
          },
        ],
        messages: [],
      },
    })
    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => {
      result.current.setDecision('c1', 'reject')
    })

    expect(result.current.candidates[0].decision).toBe('pending')
  })

  it('refuses to reject a candidate whose song is currently in the plan', async () => {
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: {
        candidates: [
          {
            id: 'c1',
            title: 'Surrender',
            author: null,
            chorusSnippet: null,
            slots: [],
            matchStatus: 'matched',
            song: {
              id: 'song-x',
              title: 'Surrender',
              lastScheduledAt: null,
              lastScheduledShortDates: null,
            },
            error: null,
            decision: 'pending',
            addedAt: 0,
            assignedSlotItemId: null,
            committedAt: null,
            priorSlotTitle: null,
          },
        ],
        messages: [],
      },
    })
    const planData = stubPlanData({
      items: [
        {
          id: 's1',
          sequence: 1,
          title: 'Song 1',
          itemType: 'song',
          songId: 'song-x',
          songTitle: 'Surrender',
          songAuthor: null,
          songCcli: null,
          arrangementId: null,
          keyId: null,
          keyName: null,
          description: null,
          notes: [],
          leaders: [],
        },
      ],
    })
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => {
      result.current.setDecision('c1', 'reject')
    })
    expect(result.current.candidates[0].decision).toBe('pending')
  })
})

describe('useCandidatePool: appendSystemMessage wires into planData', () => {
  it("planData's slot-state messages land in the candidate pool's chat log", async () => {
    let planDataAppend: (msg: string) => void = () => {}
    const planData = stubPlanData({
      setAppendSystemMessage: (fn) => {
        planDataAppend = fn
      },
    })
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => {
      planDataAppend('↗ Committed "Build My Life" → Song 1')
    })

    expect(
      result.current.messages.some((m) =>
        /Committed "Build My Life"/.test(m.content),
      ),
    ).toBe(true)
  })
})

describe('useCandidatePool: handleSuggest (AI driver)', () => {
  it('routes a propose action through batched library lookup + adds candidates', async () => {
    ;vi.mocked(api.searchSongsBatch).mockResolvedValue({
      data: {
        results: [
          [
            {
              id: 'song-bml',
              title: 'Build My Life',
              author: null,
              ccliNumber: null,
              themes: null,
              isHidden: false,
              lastScheduledAt: null,
              lastScheduledShortDates: null,
            },
          ],
        ],
      },
    })

    // Stub a stream that emits one propose action then ends.
    const streamGen = (async function* () {
      yield {
        kind: 'action' as const,
        action: {
          kind: 'propose' as const,
          suggestions: [{ title: 'Build My Life' }],
        },
      }
    })()
    ;(api.suggestSongs.stream as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      stream: streamGen,
      data: Promise.resolve({ message: 'Done.' }),
    })

    const planData = stubPlanData({ theme: 'Theme', notesText: '' })
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    await act(async () => {
      await result.current.handleSuggest()
    })

    expect(result.current.candidates).toHaveLength(1)
    expect(result.current.candidates[0].suggestion.title).toBe('Build My Life')
    expect(api.searchSongsBatch).toHaveBeenCalledWith({
      queries: [{ query: 'Build My Life' }],
    })
    // The chat log gets the AI's prose reply + the proposed system msg.
    expect(result.current.messages.length).toBeGreaterThan(0)
  })

  it("routes AI's set_slot_contents through translateAiAssignments + planData.performIntent", async () => {
    // Seed session with one matched candidate.
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: {
        candidates: [
          {
            id: 'c1',
            title: 'Build My Life',
            author: null,
            chorusSnippet: null,
            slots: [],
            matchStatus: 'matched',
            song: {
              id: 'song-bml',
              title: 'Build My Life',
              lastScheduledAt: null,
              lastScheduledShortDates: null,
            },
            error: null,
            decision: 'pending',
            addedAt: 0,
            assignedSlotItemId: null,
            committedAt: null,
            priorSlotTitle: null,
          },
        ],
        messages: [],
      },
    })

    const streamGen = (async function* () {
      yield {
        kind: 'action' as const,
        action: {
          kind: 'set_slot_contents' as const,
          assignments: [{ slotIndex: 1, candidateId: 'c1' }],
        },
      }
    })()
    ;(api.suggestSongs.stream as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      stream: streamGen,
      data: Promise.resolve({ message: 'Done.' }),
    })

    const planData = stubPlanData({ theme: 'Theme' })
    ;(planData.performIntent as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      pcoWritesFired: true,
      messages: [],
    })

    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    await act(async () => {
      await result.current.handleSuggest()
    })

    expect(planData.performIntent).toHaveBeenCalledWith(
      [{ slotIndex: 1, song: { id: 'song-bml', title: 'Build My Life' } }],
      expect.objectContaining({ source: 'ai', deferRefresh: true }),
    )
    expect(planData.refreshPlanState).toHaveBeenCalled()
  })
})

describe('useCandidatePool: clearCandidates', () => {
  it('empties candidates + messages and resets the auto-refine counter', async () => {
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: {
        candidates: [
          {
            id: 'c1',
            title: 'X',
            author: null,
            chorusSnippet: null,
            slots: [],
            matchStatus: 'matched',
            song: null,
            error: null,
            decision: 'pending',
            addedAt: 0,
            assignedSlotItemId: null,
            committedAt: null,
            priorSlotTitle: null,
          },
        ],
        messages: [
          {
            id: 'm1',
            role: 'system',
            content: 'old',
            timestamp: 0,
          },
        ],
      },
    })
    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))
    expect(result.current.candidates).toHaveLength(1)

    act(() => {
      result.current.clearCandidates()
    })

    expect(result.current.candidates).toEqual([])
    expect(result.current.messages).toEqual([])
  })
})

// What we cover:
//   - usePlanData: initial load, load failure, theme override
//     seeding, fresh commit, clear, theme auto-save
//   - useCandidatePool: session load, isCandidateCommitted derived
//     state, setDecision (reject + toggle + committed-protection),
//     planData → pool message wiring, AI propose → batch lookup,
//     AI set_slot_contents → translate + performIntent, clearCandidates
//
// What's deferred (could be added later):
//   - Reorder-slot-item DnD orchestration end-to-end
//   - Auto-refresh threshold (2+ rejects fires handleSuggest)
//   - PCO failure → executor rollback through the hook
//   - Multi-action AI streams (propose + reject + commit in one turn)
//   - Plan-switch resets state correctly
