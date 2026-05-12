import { useEffect, useState } from 'react'
import {
  getAdminPromptConfig,
  getRejectionReasons,
  removeCommonReason,
  saveAdminPromptConfig,
  type AdminPromptConfig,
  type CommonReason,
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

      <RejectionReasonsSection />
    </div>
  )
}

function RejectionReasonsSection() {
  const [reasons, setReasons] = useState<CommonReason[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removingText, setRemovingText] = useState<string | null>(null)

  async function refresh() {
    setError(null)
    try {
      const res = await getRejectionReasons()
      setReasons(res.data.common)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function handleRemove(text: string) {
    setRemovingText(text)
    setError(null)
    try {
      const res = await removeCommonReason({ text })
      setReasons(res.data.common)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRemovingText(null)
    }
  }

  return (
    <section className="admin-section">
      <h3>Reject-reason chips (system-wide pool)</h3>
      <p className="help">
        The clickable chips that show up on the reject-rationale picker.
        Seeded with a handful of defaults; grows automatically as users
        type freeform reasons (Claude distills the freeform log into new
        chip-worthy categories after every few entries). Removing a chip
        here pulls it from every user's picker immediately.
      </p>
      {error && <div className="error">{error}</div>}
      {reasons === null ? (
        <p className="muted">Loading…</p>
      ) : reasons.length === 0 ? (
        <p className="muted">No chips yet — the pool will fill in as users reject songs and add reasons.</p>
      ) : (
        <ul className="admin-reason-list">
          {reasons.map((r) => (
            <li key={r.text} className="admin-reason-item">
              <span className="admin-reason-text">{r.text}</span>
              <span className={`admin-reason-source source-${r.source}`}>
                {sourceLabel(r.source)}
              </span>
              <span className="admin-reason-date">
                {formatAddedAt(r.addedAt)}
              </span>
              <button
                type="button"
                className="admin-reason-remove"
                onClick={() => void handleRemove(r.text)}
                disabled={removingText !== null}
                title="Remove this chip from the global pool"
                aria-label={`Remove "${r.text}"`}
              >
                {removingText === r.text ? '…' : '×'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function sourceLabel(source: CommonReason['source']): string {
  switch (source) {
    case 'seed':
      return 'seed'
    case 'ai':
      return 'AI-distilled'
    case 'manual':
      return 'manual'
    default:
      return source
  }
}

function formatAddedAt(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
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
