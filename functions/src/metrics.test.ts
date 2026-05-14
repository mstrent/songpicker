import { describe, expect, it, vi } from 'vitest'

// Stub firebase-admin/firestore before metrics.ts is imported, so the
// FieldValue.serverTimestamp() / increment() calls inside the pure
// helper return predictable sentinels we can assert against without
// initializing the admin SDK. vi.mock is hoisted above the import.
const SERVER_TIMESTAMP = Symbol('serverTimestamp')
const INCREMENT_1 = Symbol('increment(1)')

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => SERVER_TIMESTAMP,
    increment: (n: number) => (n === 1 ? INCREMENT_1 : Symbol(`increment(${n})`)),
  },
  Timestamp: class {
    static fromDate() {
      throw new Error('Timestamp.fromDate not used in this test')
    }
  },
  getFirestore: () => {
    throw new Error('getFirestore should not be called from buildMetricUpdate')
  },
}))

import { buildMetricUpdate, METRIC_ACTIONS, recordMetric } from './metrics'

describe('buildMetricUpdate', () => {
  it('first write (no existing doc) sets firstSeenAt and increments the action counter', () => {
    const out = buildMetricUpdate(null, 'signIns', 'matt@thetrents.org')
    expect(out).toEqual({
      email: 'matt@thetrents.org',
      firstSeenAt: SERVER_TIMESTAMP,
      lastSeenAt: SERVER_TIMESTAMP,
      signIns: INCREMENT_1,
    })
  })

  it('subsequent write does not set firstSeenAt', () => {
    const out = buildMetricUpdate({ email: 'x' }, 'plansOpened', 'matt@thetrents.org')
    expect(out.firstSeenAt).toBeUndefined()
    expect(out).toMatchObject({
      email: 'matt@thetrents.org',
      lastSeenAt: SERVER_TIMESTAMP,
      plansOpened: INCREMENT_1,
    })
  })

  it('refreshes email on every write so a renamed account picks up the new address', () => {
    const out = buildMetricUpdate({ email: 'old@x' }, 'aiSuggestions', 'new@x')
    expect(out.email).toBe('new@x')
  })

  it('only the named action is incremented', () => {
    for (const action of METRIC_ACTIONS) {
      const out = buildMetricUpdate(null, action, 'm@x') as Record<string, unknown>
      const otherActions = METRIC_ACTIONS.filter((a) => a !== action)
      for (const other of otherActions) {
        expect(out[other]).toBeUndefined()
      }
      expect(out[action]).toBe(INCREMENT_1)
    }
  })
})

describe('recordMetric', () => {
  // The vi.mock above makes getFirestore() throw. recordMetric must
  // swallow that and log a warning — a flaky Firestore write must
  // never propagate into the user-facing callable.
  it('swallows Firestore errors and logs a warning instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      recordMetric('uid-1', 'matt@thetrents.org', 'signIns'),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      '[metrics] write failed:',
      expect.any(Error),
    )
    warn.mockRestore()
  })
})
