import { useCallback, useEffect, useState } from 'react'
import {
  getPromptConfig,
  savePromptConfig,
  type PromptConfig,
  type PromptType,
} from './api'

// Shared loader/saver for an AI prompt (persona or service-flow). Used by
// both the PromptPill (which needs the resolved source label) and the
// PromptBody (which needs the editable draft + save handlers), so the
// config is fetched once and shared.
export function usePromptConfig(type: PromptType, planId: string) {
  const [config, setConfig] = useState<PromptConfig | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState<'plan' | 'default' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await getPromptConfig({ type, planId })
      setConfig(res.data)
      setDraft(res.data.effective.value)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [type, planId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(
    async (scope: 'plan' | 'default') => {
      if (!config) return
      setSaving(scope)
      setError(null)
      try {
        await savePromptConfig({ type, scope, planId, value: draft })
        await refresh()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setSaving(null)
      }
    },
    [config, draft, planId, refresh, type],
  )

  const resetPlanOverride = useCallback(async () => {
    setSaving('reset')
    setError(null)
    try {
      await savePromptConfig({ type, scope: 'plan', planId, value: '' })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(null)
    }
  }, [planId, refresh, type])

  const dirty = config ? draft !== config.effective.value : false
  const hasPlanOverride = config ? !!config.planOverride.trim() : false

  return {
    config,
    draft,
    setDraft,
    saving,
    error,
    save,
    resetPlanOverride,
    dirty,
    hasPlanOverride,
  }
}

export type PromptConfigHookResult = ReturnType<typeof usePromptConfig>
