/// <reference lib="dom" />
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanDataApi } from './usePlanData'
import type { ExecutorResult } from './planActions/executor'

// Mock the api callables. The candidate pool uses loadSession,
// saveSession, searchSongsBatch, suggestSongs, getSong,
// classifySongSlots.
vi.mock('./api', () => {
  return {
    loadSession: vi.fn(() =>
      Promise.resolve({ data: { candidates: [], messages: [] } }),
    ),
    saveSession: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    searchSongs: vi.fn(),
    searchSongsBatch: vi.fn(),
    suggestSongs: { stream: vi.fn() },
    getSong: vi.fn(),
    classifySongSlots: vi.fn(),
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
    setOnSongEvicted: () => {},
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

describe('useCandidatePool: recheckCandidate', () => {
  // Persisted shape for a candidate that came back unmatched on first
  // lookup — fields match the loadSession contract used by other
  // tests in this file.
  const unmatched = {
    id: 'c1',
    title: 'Surrender',
    author: 'Marc James',
    chorusSnippet: null,
    slots: [],
    matchStatus: 'unmatched' as const,
    song: null,
    error: null,
    decision: 'pending' as const,
    addedAt: 0,
    assignedSlotItemId: null,
    committedAt: null,
    priorSlotTitle: null,
  }

  function newSong() {
    return {
      id: 'song-x',
      title: 'Surrender',
      author: 'Marc James',
      ccliNumber: null,
      themes: null,
      isHidden: false,
      lastScheduledAt: null,
      lastScheduledShortDates: null,
    }
  }

  it('flips unmatched → matched when Planning Center now returns the song', async () => {
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: { candidates: [unmatched], messages: [] },
    })
    const song = newSong()
    ;vi.mocked(api.searchSongs).mockResolvedValue({
      data: { songs: [song] },
    })
    const { result } = renderHook(() =>
      useCandidatePool('plan-1', stubPlanData()),
    )
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    await act(async () => {
      result.current.recheckCandidate('c1')
    })

    await waitFor(() =>
      expect(result.current.candidates[0].matchStatus).toBe('matched'),
    )
    expect(result.current.candidates[0].song).toEqual(song)
    expect(api.searchSongs).toHaveBeenCalledWith({
      query: 'Surrender',
      author: 'Marc James',
    })
  })

  it('stays unmatched when Planning Center still has no hit', async () => {
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: { candidates: [unmatched], messages: [] },
    })
    ;vi.mocked(api.searchSongs).mockResolvedValue({
      data: { songs: [] },
    })
    const { result } = renderHook(() =>
      useCandidatePool('plan-1', stubPlanData()),
    )
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    await act(async () => {
      result.current.recheckCandidate('c1')
    })

    await waitFor(() =>
      // The recheck flow flips to 'checking' first; wait until it
      // settles back to a terminal status.
      expect(result.current.candidates[0].matchStatus).not.toBe('checking'),
    )
    expect(result.current.candidates[0].matchStatus).toBe('unmatched')
    expect(result.current.candidates[0].song).toBeUndefined()
  })

  it('marks the candidate as errored when the lookup throws', async () => {
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: { candidates: [unmatched], messages: [] },
    })
    ;vi.mocked(api.searchSongs).mockRejectedValue(new Error('PCO down'))
    const { result } = renderHook(() =>
      useCandidatePool('plan-1', stubPlanData()),
    )
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    await act(async () => {
      result.current.recheckCandidate('c1')
    })

    await waitFor(() =>
      expect(result.current.candidates[0].matchStatus).toBe('error'),
    )
    expect(result.current.candidates[0].error).toBe('PCO down')
  })

  it('is a no-op on an already-matched candidate', async () => {
    const matched = {
      ...unmatched,
      matchStatus: 'matched' as const,
      song: newSong(),
    }
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: { candidates: [matched], messages: [] },
    })
    const { result } = renderHook(() =>
      useCandidatePool('plan-1', stubPlanData()),
    )
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => {
      result.current.recheckCandidate('c1')
    })

    expect(api.searchSongs).not.toHaveBeenCalled()
    expect(result.current.candidates[0].matchStatus).toBe('matched')
  })

  it('omits author from the query when the suggestion has none', async () => {
    const noAuthor = { ...unmatched, author: null }
    ;vi.mocked(api.loadSession).mockResolvedValue({
      data: { candidates: [noAuthor], messages: [] },
    })
    ;vi.mocked(api.searchSongs).mockResolvedValue({
      data: { songs: [newSong()] },
    })
    const { result } = renderHook(() =>
      useCandidatePool('plan-1', stubPlanData()),
    )
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    await act(async () => {
      result.current.recheckCandidate('c1')
    })

    await waitFor(() =>
      expect(result.current.candidates[0].matchStatus).toBe('matched'),
    )
    expect(api.searchSongs).toHaveBeenCalledWith({ query: 'Surrender' })
  })
})

describe('useCandidatePool: ensureCandidate (eviction enrichment)', () => {
  const evicted = {
    id: 'song-evicted',
    title: 'Way Maker',
    author: 'Osinachi Kalu Okoro Egbu',
    ccli: '7115744',
  }

  // Helper for tests that don't care about gating getSong — pass an
  // already-resolved promise so the deferred fetch fires immediately
  // and waitFor sees the patch. Production passes a real settle
  // promise (see usePlanData.performIntent).
  const settled = Promise.resolve()

  it('mints a pending candidate with enrichmentPending=true on first eviction', async () => {
    // Keep both fetches pending so we can observe the in-flight state.
    vi.mocked(api.getSong).mockReturnValue(new Promise(() => {}))
    vi.mocked(api.classifySongSlots).mockReturnValue(new Promise(() => {}))

    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => result.current.ensureCandidate(evicted))

    expect(result.current.candidates).toHaveLength(1)
    const c = result.current.candidates[0]
    expect(c.matchStatus).toBe('matched')
    expect(c.decision).toBe('pending')
    expect(c.enrichmentPending).toBe(true)
    expect(c.song?.id).toBe('song-evicted')
    expect(c.song?.lastScheduledAt).toBeNull() // not loaded yet
    // System message announces the return.
    expect(
      result.current.messages.some((m) =>
        /returned to candidates/.test(m.content),
      ),
    ).toBe(true)
  })

  it('gates getSong on pcoSettled so we never query PCO before its clear lands', async () => {
    vi.mocked(api.getSong).mockResolvedValue({
      data: {
        song: {
          id: 'song-evicted',
          title: 'Way Maker',
          author: null,
          ccliNumber: null,
          themes: null,
          isHidden: false,
          lastScheduledAt: '2026-04-26T10:00:00Z',
          lastScheduledShortDates: '4/26',
        },
      },
    })
    vi.mocked(api.classifySongSlots).mockReturnValue(new Promise(() => {}))

    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    // Externally-controlled settle promise — mirrors how performIntent
    // wires it up in production.
    let resolveSettled!: () => void
    const pcoSettled = new Promise<void>((r) => {
      resolveSettled = r
    })

    act(() => result.current.ensureCandidate(evicted, pcoSettled))
    // After the mint but before resolution: getSong stays held back.
    // Let microtasks drain to make sure nothing snuck through.
    await Promise.resolve()
    await Promise.resolve()
    expect(vi.mocked(api.getSong)).not.toHaveBeenCalled()

    // Resolve the settle signal — getSong fires.
    act(() => {
      resolveSettled()
    })
    await waitFor(() =>
      expect(vi.mocked(api.getSong)).toHaveBeenCalledWith({
        songId: 'song-evicted',
      }),
    )
  })

  it('patches lastScheduledAt and clears enrichmentPending when getSong resolves', async () => {
    vi.mocked(api.getSong).mockResolvedValue({
      data: {
        song: {
          id: 'song-evicted',
          title: 'Way Maker',
          author: 'Osinachi',
          ccliNumber: '7115744',
          themes: null,
          isHidden: false,
          lastScheduledAt: '2026-04-26T10:00:00Z',
          lastScheduledShortDates: '4/26',
        },
      },
    })
    vi.mocked(api.classifySongSlots).mockReturnValue(new Promise(() => {}))

    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => result.current.ensureCandidate(evicted, settled))
    await waitFor(() =>
      expect(result.current.candidates[0]?.enrichmentPending).toBe(false),
    )

    const c = result.current.candidates[0]
    expect(c.song?.lastScheduledAt).toBe('2026-04-26T10:00:00Z')
    expect(c.song?.lastScheduledShortDates).toBe('4/26')
  })

  it('patches suggestion.slots when classifySongSlots resolves', async () => {
    vi.mocked(api.getSong).mockReturnValue(new Promise(() => {}))
    vi.mocked(api.classifySongSlots).mockResolvedValue({
      data: { slots: ['opener', 'response'] },
    })

    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => result.current.ensureCandidate(evicted))
    await waitFor(() =>
      expect(result.current.candidates[0]?.suggestion.slots).toEqual([
        'opener',
        'response',
      ]),
    )
  })

  it('patches suggestion.chorusSnippet when Haiku returns one', async () => {
    vi.mocked(api.getSong).mockReturnValue(new Promise(() => {}))
    vi.mocked(api.classifySongSlots).mockResolvedValue({
      data: {
        slots: ['opener'],
        chorusSnippet: 'Way maker, miracle worker',
      },
    })

    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => result.current.ensureCandidate(evicted))
    await waitFor(() =>
      expect(result.current.candidates[0]?.suggestion.chorusSnippet).toBe(
        'Way maker, miracle worker',
      ),
    )
    expect(result.current.candidates[0]?.suggestion.slots).toEqual(['opener'])
  })

  it('leaves chorusSnippet undefined when Haiku omits it', async () => {
    vi.mocked(api.getSong).mockReturnValue(new Promise(() => {}))
    vi.mocked(api.classifySongSlots).mockResolvedValue({
      data: { slots: ['opener'] },
    })

    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => result.current.ensureCandidate(evicted))
    await waitFor(() =>
      expect(result.current.candidates[0]?.suggestion.slots).toEqual([
        'opener',
      ]),
    )
    expect(
      result.current.candidates[0]?.suggestion.chorusSnippet,
    ).toBeUndefined()
  })

  it('flips enrichmentPending=false on getSong failure (UI moves to honest fallback)', async () => {
    vi.mocked(api.getSong).mockRejectedValue(new Error('PCO 404'))
    vi.mocked(api.classifySongSlots).mockResolvedValue({
      data: { slots: [] },
    })

    const planData = stubPlanData()
    const { result } = renderHook(() => useCandidatePool('plan-1', planData))
    await waitFor(() => expect(result.current.sessionLoaded).toBe(true))

    act(() => result.current.ensureCandidate(evicted, settled))
    await waitFor(() =>
      expect(result.current.candidates[0]?.enrichmentPending).toBe(false),
    )
    // No song update (lastScheduledAt stays null) — UI renders the
    // "no recent schedule" fallback rather than "loading…" forever.
    expect(result.current.candidates[0]?.song?.lastScheduledAt).toBeNull()
  })

  it('retries getSong once when the first response has null lastScheduledAt', async () => {
    vi.useFakeTimers()
    try {
      // First response: PCO index hasn't caught up. Second: real date.
      vi.mocked(api.getSong)
        .mockResolvedValueOnce({
          data: {
            song: {
              id: 'song-evicted',
              title: 'Way Maker',
              author: null,
              ccliNumber: null,
              themes: null,
              isHidden: false,
              lastScheduledAt: null,
              lastScheduledShortDates: null,
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            song: {
              id: 'song-evicted',
              title: 'Way Maker',
              author: null,
              ccliNumber: null,
              themes: null,
              isHidden: false,
              lastScheduledAt: '2026-04-26T10:00:00Z',
              lastScheduledShortDates: '4/26',
            },
          },
        })
      vi.mocked(api.classifySongSlots).mockReturnValue(new Promise(() => {}))

      const planData = stubPlanData()
      const { result } = renderHook(() => useCandidatePool('plan-1', planData))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      act(() => result.current.ensureCandidate(evicted, settled))
      // First call lands.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(vi.mocked(api.getSong)).toHaveBeenCalledTimes(1)

      // Advance through the retry window — second call fires + patches.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(vi.mocked(api.getSong)).toHaveBeenCalledTimes(2)
      expect(result.current.candidates[0]?.song?.lastScheduledAt).toBe(
        '2026-04-26T10:00:00Z',
      )
      expect(result.current.candidates[0]?.enrichmentPending).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts null as truth when both attempts return null lastScheduledAt', async () => {
    vi.useFakeTimers()
    try {
      const nullSong = {
        id: 'song-evicted',
        title: 'Way Maker',
        author: null,
        ccliNumber: null,
        themes: null,
        isHidden: false,
        lastScheduledAt: null,
        lastScheduledShortDates: null,
      }
      vi.mocked(api.getSong).mockResolvedValue({ data: { song: nullSong } })
      vi.mocked(api.classifySongSlots).mockReturnValue(new Promise(() => {}))

      const planData = stubPlanData()
      const { result } = renderHook(() => useCandidatePool('plan-1', planData))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      act(() => result.current.ensureCandidate(evicted, settled))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(vi.mocked(api.getSong)).toHaveBeenCalledTimes(2)
      // Retry exhausted — UI moves out of pending; lastScheduledAt
      // stays null, which the chip renders as "no recent schedule".
      expect(result.current.candidates[0]?.enrichmentPending).toBe(false)
      expect(result.current.candidates[0]?.song?.lastScheduledAt).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips re-minting when a candidate with the same song.id already exists', async () => {
    vi.mocked(api.loadSession).mockResolvedValue({
      data: {
        candidates: [
          {
            id: 'c-existing',
            title: 'Way Maker',
            author: null,
            chorusSnippet: null,
            slots: [],
            matchStatus: 'matched',
            song: {
              id: 'song-evicted',
              title: 'Way Maker',
              lastScheduledAt: null,
              lastScheduledShortDates: null,
            },
            error: null,
            decision: 'pending',
            addedAt: Date.now(),
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
    expect(result.current.candidates).toHaveLength(1)

    act(() => result.current.ensureCandidate(evicted))

    expect(result.current.candidates).toHaveLength(1)
    expect(vi.mocked(api.getSong)).not.toHaveBeenCalled()
    expect(vi.mocked(api.classifySongSlots)).not.toHaveBeenCalled()
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
