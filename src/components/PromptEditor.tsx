import { useEffect, useState } from 'react'
import {
  getPromptConfig,
  savePromptConfig,
  type PromptConfig,
  type PromptSource,
  type PromptType,
} from '../lib/api'

interface Props {
  type: PromptType
  planId: string
}

interface Copy {
  label: string
  help: string
}

const COPY: Record<PromptType, Copy> = {
  structure: {
    label: 'AI service-flow prompt',
    help: 'Extra context the AI receives on every Suggest call, shaping how songs are distributed across the service (opener, mid-service, closer, etc.).',
  },
  role: {
    label: 'AI persona',
    help: "Describe the AI's persona — who it is, how it should think about your service, the kind of church you lead, the theological frame you prefer, etc. The technical JSON-format requirements are added behind the scenes, so you can edit freely without breaking output.",
  },
}

function sourceLabel(source: PromptSource): string {
  switch (source) {
    case 'plan':
      return 'this plan'
    case 'user':
      return 'yours'
    case 'system':
      return 'default'
  }
}

function sourceTooltip(source: PromptSource): string {
  switch (source) {
    case 'plan':
      return 'Using this plan’s override'
    case 'user':
      return 'Using your saved default'
    case 'system':
      return 'Using the built-in default'
  }
}

export function PromptEditor({ type, planId }: Props) {
  const copy = COPY[type]
  const [config, setConfig] = useState<PromptConfig | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState<'plan' | 'default' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setError(null)
    try {
      const res = await getPromptConfig({ type, planId })
      setConfig(res.data)
      setDraft(res.data.effective.value)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    void refresh()
  }, [type, planId])

  async function save(scope: 'plan' | 'default') {
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
  }

  async function resetPlanOverride() {
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
  }

  if (!config) {
    return (
      <details className="structure-prompt ai-affordance">
        <summary>
          <span className="chevron" aria-hidden>▸</span>
          <span className="sparkle" aria-hidden>✨</span>
          <span className="gradient-text">{copy.label}</span>
        </summary>
        <div className="body">Loading…</div>
      </details>
    )
  }

  const dirty = draft !== config.effective.value
  const hasPlanOverride = !!config.planOverride.trim()

  return (
    <details className="structure-prompt ai-affordance">
      <summary>
        <span className="chevron" aria-hidden>▸</span>
        <span className="sparkle" aria-hidden>✨</span>
        <span className="gradient-text">{copy.label}</span>
        <span
          className="source-tag"
          title={sourceTooltip(config.effective.source)}
        >
          {sourceLabel(config.effective.source)}
        </span>
      </summary>
      <div className="body">
        <p className="help">{copy.help}</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={5}
          disabled={!!saving}
        />
        <div className="actions">
          <button
            onClick={() => save('plan')}
            disabled={!!saving || !dirty}
            title="Use this prompt for this specific plan only"
          >
            {saving === 'plan' ? 'Saving…' : 'Save for this plan'}
          </button>
          <button
            className="ghost"
            onClick={() => save('default')}
            disabled={!!saving || !dirty}
            title="Use this prompt for any plan that doesn't have its own override"
          >
            {saving === 'default' ? 'Saving…' : 'Save as my default'}
          </button>
          {hasPlanOverride && (
            <button
              className="ghost danger"
              onClick={resetPlanOverride}
              disabled={!!saving}
              title="Remove this plan's override and fall back to your default"
            >
              {saving === 'reset' ? 'Resetting…' : 'Reset this plan'}
            </button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </details>
  )
}
