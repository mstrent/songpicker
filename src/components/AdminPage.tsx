import { useEffect, useState } from 'react'
import {
  getAdminPromptConfig,
  saveAdminPromptConfig,
  type AdminPromptConfig,
  type PromptType,
} from '../lib/api'

const COPY: Record<PromptType, { label: string; help: string }> = {
  role: {
    label: 'AI persona (system-wide default)',
    help: "What users see in their AI persona editor when they haven't set their own override. Save blank to fall back to the hardcoded default below.",
  },
  structure: {
    label: 'AI service-flow prompt (system-wide default)',
    help: "What users see in their AI service-flow editor when they haven't set their own override. Save blank to fall back to the hardcoded default below.",
  },
}

export function AdminPage() {
  const [config, setConfig] = useState<AdminPromptConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setError(null)
    try {
      const res = await getAdminPromptConfig()
      setConfig(res.data)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  if (error) return <div className="error">Error: {error}</div>
  if (!config) return <div>Loading…</div>

  const composedSample = `${(config.role.admin || config.role.hardcoded).trim()}\n\n${config.technical}`

  return (
    <div className="admin-page">
      <a
        className="back"
        href="#"
        onClick={(e) => {
          e.preventDefault()
          window.location.hash = ''
        }}
      >
        ← Back
      </a>
      <h2>
        <span className="sparkle" aria-hidden>✨</span>
        <span className="gradient-text">Admin · AI defaults</span>
      </h2>
      <p className="muted">
        Edit the system-wide defaults that apply when individual users
        haven't set their own. User-level and per-plan overrides still
        take precedence.
      </p>

      <AdminPromptSection
        type="role"
        config={config.role}
        onSaved={() => void refresh()}
      />
      <AdminPromptSection
        type="structure"
        config={config.structure}
        onSaved={() => void refresh()}
      />

      <section className="admin-section read-only">
        <h3>Technical requirements (read-only)</h3>
        <p className="help">
          Always appended to the AI persona before being sent as the
          model's system message. Hidden from regular users; shown here
          so admins can see exactly what the model is asked to enforce.
        </p>
        <pre>{config.technical}</pre>
      </section>

      <section className="admin-section read-only">
        <h3>Composed system prompt (preview)</h3>
        <p className="help">
          What the model actually receives as the system message when a
          user is on the persona default and structure-flow text is
          excluded.
        </p>
        <pre>{composedSample}</pre>
      </section>
    </div>
  )
}

function AdminPromptSection({
  type,
  config,
  onSaved,
}: {
  type: PromptType
  config: { admin: string; hardcoded: string }
  onSaved: () => void
}) {
  const initial = config.admin || config.hardcoded
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState<'save' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const copy = COPY[type]

  useEffect(() => {
    setDraft(config.admin || config.hardcoded)
  }, [config.admin, config.hardcoded])

  async function save(value: string, mode: 'save' | 'reset') {
    setSaving(mode)
    setError(null)
    try {
      await saveAdminPromptConfig({ type, value })
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(null)
    }
  }

  const hasAdminOverride = !!config.admin.trim()
  const dirty = draft !== (config.admin || config.hardcoded)

  return (
    <section className="admin-section">
      <h3>{copy.label}</h3>
      <p className="help">{copy.help}</p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={6}
        disabled={!!saving}
      />
      <div className="actions">
        <button
          onClick={() => save(draft, 'save')}
          disabled={!!saving || !dirty}
        >
          {saving === 'save' ? 'Saving…' : 'Save as system-wide default'}
        </button>
        {hasAdminOverride && (
          <button
            className="ghost danger"
            onClick={() => save('', 'reset')}
            disabled={!!saving}
            title="Remove the admin override and fall back to the hardcoded default"
          >
            {saving === 'reset' ? 'Resetting…' : 'Reset to hardcoded default'}
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <details className="hardcoded-display">
        <summary>Hardcoded fallback</summary>
        <pre>{config.hardcoded}</pre>
      </details>
    </section>
  )
}
