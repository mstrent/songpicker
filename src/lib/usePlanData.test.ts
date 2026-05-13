/// <reference lib="dom" />
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanItem } from './api'

// Mock the api module up front. Each test seeds the mock with the
// callable responses it needs. Callables are typed `httpsCallable`
// in production; tests treat them as functions returning
// `{ data: ... }` (matching httpsCallable's resolved shape).
vi.mock('./api', () => {
  return {
    placeSongInSlot: vi.fn(),
    clearSongFromSlot: vi.fn(),
    refreshSlotState: vi.fn(),
    savePlanNotes: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    savePlanTheme: vi.fn(() => Promise.resolve({ data: { ok: true } })),
  }
})

// Mock the cache module so tests don't depend on the real session
// cache. loadPlanContext returns a promise the test resolves; the
// patch helpers are no-op spies.
vi.mock('./cache', () => {
  const loadPlanContext = vi.fn()
  return {
    loadPlanContext,
    invalidatePlanContext: vi.fn(),
    patchCachedTheme: vi.fn(),
    patchCachedNotes: vi.fn(),
    patchCachedSlotState: vi.fn(),
  }
})

// Imports must come AFTER vi.mock so the mocks are wired in.
import * as api from './api'
import * as cache from './cache'
import { usePlanData } from './usePlanData'

function makeItem(partial: Partial<PlanItem> & Pick<PlanItem, 'id'>): PlanItem {
  return {
    id: partial.id,
    sequence: partial.sequence ?? 1,
    title: partial.title ?? '',
    itemType: partial.itemType ?? 'song',
    songId: partial.songId ?? null,
    songTitle: partial.songTitle ?? null,
    songAuthor: partial.songAuthor ?? null,
    songCcli: partial.songCcli ?? null,
    arrangementId: partial.arrangementId ?? null,
    keyId: partial.keyId ?? null,
    keyName: partial.keyName ?? null,
    description: partial.description ?? null,
    notes: partial.notes ?? [],
    leaders: partial.leaders ?? [],
  }
}

const SAMPLE_PLAN_CONTEXT = {
  plan: {
    id: 'plan-1',
    serviceTypeId: 'st-1',
    serviceTypeName: 'Sunday Services',
    title: 'Sample plan',
    seriesTitle: 'Series',
    sortDate: '2026-05-13',
  },
  notes: [],
  items: [
    makeItem({ id: 's1', sequence: 1, title: 'Song 1' }),
    makeItem({ id: 's2', sequence: 2, title: 'Song 2' }),
  ],
  userTheme: '',
  userNotes: '',
  slotPlaceholders: {},
}

beforeEach(() => {
  vi.clearAllMocks()
  ;vi.mocked(cache.loadPlanContext).mockResolvedValue(
    SAMPLE_PLAN_CONTEXT,
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePlanData: initial load', () => {
  it('hydrates plan/items/slotPlaceholders from loadPlanContext', async () => {
    const { result } = renderHook(() => usePlanData('st-1', 'plan-1'))
    await waitFor(() => {
      expect(result.current.plan).not.toBeNull()
    })
    expect(result.current.items).toHaveLength(2)
    expect(result.current.themeSource).toBe('Series')
    expect(result.current.theme).toBe('Series')
    expect(result.current.loadError).toBeNull()
  })

  it('seeds theme from saved override when present', async () => {
    ;vi.mocked(cache.loadPlanContext).mockResolvedValue({
      ...SAMPLE_PLAN_CONTEXT,
      userTheme: 'Custom theme',
    })
    const { result } = renderHook(() => usePlanData('st-1', 'plan-1'))
    await waitFor(() => {
      expect(result.current.theme).toBe('Custom theme')
    })
    expect(result.current.themeSource).toBe('Series')
  })

  it('surfaces loadPlanContext failure as loadError', async () => {
    ;vi.mocked(cache.loadPlanContext).mockRejectedValue(
      new Error('PCO down'),
    )
    const { result } = renderHook(() => usePlanData('st-1', 'plan-1'))
    await waitFor(() => {
      expect(result.current.loadError).toBe('PCO down')
    })
  })
})

describe('usePlanData: performIntent', () => {
  it('runs a fresh commit through the executor and refreshes slot state', async () => {
    ;vi.mocked(api.placeSongInSlot).mockResolvedValue({
      data: { ok: true },
    })
    ;vi.mocked(api.refreshSlotState).mockResolvedValue({
      data: {
        items: [
          makeItem({
            id: 's1',
            sequence: 1,
            title: 'Build My Life',
            songId: 'song-bml',
            songTitle: 'Build My Life',
          }),
          makeItem({ id: 's2', sequence: 2, title: 'Song 2' }),
        ],
        slotPlaceholders: {},
      },
    })
    const { result } = renderHook(() => usePlanData('st-1', 'plan-1'))
    await waitFor(() => expect(result.current.plan).not.toBeNull())

    await act(async () => {
      await result.current.performIntent([
        { slotIndex: 1, song: { id: 'song-bml', title: 'Build My Life' } },
      ])
    })

    expect(api.placeSongInSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        slotItemId: 's1',
        songId: 'song-bml',
        songTitle: 'Build My Life',
      }),
    )
    expect(api.refreshSlotState).toHaveBeenCalled()
    expect(result.current.items?.[0].songId).toBe('song-bml')
  })

  it('runs a clear through the executor', async () => {
    ;vi.mocked(cache.loadPlanContext).mockResolvedValue({
      ...SAMPLE_PLAN_CONTEXT,
      items: [
        makeItem({
          id: 's1',
          sequence: 1,
          title: 'Build My Life',
          songId: 'song-bml',
          songTitle: 'Build My Life',
        }),
        makeItem({ id: 's2', sequence: 2, title: 'Song 2' }),
      ],
    })
    ;vi.mocked(api.clearSongFromSlot).mockResolvedValue({
      data: { ok: true },
    })
    ;vi.mocked(api.refreshSlotState).mockResolvedValue({
      data: {
        items: [
          makeItem({ id: 's1', sequence: 1, title: 'Song 1' }),
          makeItem({ id: 's2', sequence: 2, title: 'Song 2' }),
        ],
        slotPlaceholders: {},
      },
    })
    const { result } = renderHook(() => usePlanData('st-1', 'plan-1'))
    await waitFor(() => expect(result.current.plan).not.toBeNull())

    await act(async () => {
      await result.current.performIntent([{ slotIndex: 1, song: null }])
    })

    expect(api.clearSongFromSlot).toHaveBeenCalledWith(
      expect.objectContaining({ slotItemId: 's1', restoreTitle: 'Song 1' }),
    )
    expect(result.current.items?.[0].songId).toBeNull()
  })
})

describe('usePlanData: theme/notes', () => {
  it('setTheme + auto-save fires after debounce', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => usePlanData('st-1', 'plan-1'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    act(() => {
      result.current.setTheme('My theme')
    })
    expect(result.current.theme).toBe('My theme')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })

    expect(api.savePlanTheme).toHaveBeenCalledWith({
      planId: 'plan-1',
      theme: 'My theme',
    })
  })
})
