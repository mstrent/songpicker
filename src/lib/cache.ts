import {
  getPlanContext,
  type Plan,
  type PlanItem,
  type PlanNote,
} from './api'

interface PlanContext {
  plan: Plan
  notes: PlanNote[]
  items: PlanItem[]
  userTheme: string
  userNotes: string
  slotPlaceholders: Record<string, string>
}

// Session-scoped cache for getPlanContext. Keyed by serviceTypeId/planId.
// Avoids re-hitting PCO when the user navigates away and back to a plan
// they already loaded. In-memory only — refreshes on page reload.
const contextCache = new Map<string, Promise<PlanContext>>()

function key(serviceTypeId: string, planId: string): string {
  return `${serviceTypeId}/${planId}`
}

export async function loadPlanContext(
  serviceTypeId: string,
  planId: string,
): Promise<PlanContext> {
  const k = key(serviceTypeId, planId)
  let pending = contextCache.get(k)
  if (!pending) {
    pending = getPlanContext({ serviceTypeId, planId })
      .then((res) => res.data)
      .catch((e) => {
        // Don't poison the cache with a failed lookup.
        contextCache.delete(k)
        throw e
      })
    contextCache.set(k, pending)
  }
  return pending
}

export function invalidatePlanContext(
  serviceTypeId: string,
  planId: string,
): void {
  contextCache.delete(key(serviceTypeId, planId))
}

// Patches the cached userTheme without an extra round-trip. Call after
// savePlanTheme so a subsequent visit to the plan doesn't show stale data.
export function patchCachedTheme(
  serviceTypeId: string,
  planId: string,
  theme: string,
): void {
  const k = key(serviceTypeId, planId)
  const pending = contextCache.get(k)
  if (!pending) return
  contextCache.set(
    k,
    pending.then((ctx) => ({ ...ctx, userTheme: theme })),
  )
}

export function patchCachedNotes(
  serviceTypeId: string,
  planId: string,
  notes: string,
): void {
  const k = key(serviceTypeId, planId)
  const pending = contextCache.get(k)
  if (!pending) return
  contextCache.set(
    k,
    pending.then((ctx) => ({ ...ctx, userNotes: notes })),
  )
}
