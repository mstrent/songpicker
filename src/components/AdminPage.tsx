import { useEffect, useRef, useState } from 'react'
import {
  addAccessEntry,
  getAccessConfig,
  getAdminPromptConfig,
  getRejectionReasons,
  removeAccessEntry,
  removeCommonReason,
  renameCommonReason,
  saveAdminPromptConfig,
  type AccessConfig,
  type AccessList,
  type AdminPromptConfig,
  type CommonReason,
  type PromptType,
} from '../lib/api'
import { Icon } from './Icon'
import { activeAiChipTexts } from '../lib/chipRanking'

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

  // Mount fetch via .then() to keep setState off the synchronous path
  // of the effect body (react-hooks/set-state-in-effect). The user-
  // initiated refresh() above stays for post-save / post-action reloads
  // from click handlers, where the rule doesn't apply.
  useEffect(() => {
    let cancelled = false
    getAdminPromptConfig()
      .then((res) => {
        if (!cancelled) setConfig(res.data)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
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
        <details className="hardcoded-display">
          <summary>View technical requirements</summary>
          <pre>{config.technical}</pre>
        </details>
      </section>

      <RejectionReasonsSection />
      <AccessSection />
    </div>
  )
}

// Entry-format validator mirroring functions/src/access.ts:entryIsValid.
// Accepts "name@example.com" or "@example.com" (domain wildcard).
function entryIsValid(raw: string): boolean {
  const s = raw.trim().toLowerCase()
  if (!s) return false
  if (s.startsWith('@')) return s.length > 1 && !s.slice(1).includes('@')
  const at = s.indexOf('@')
  return at > 0 && at === s.lastIndexOf('@') && at < s.length - 1
}

function AccessSection() {
  const [config, setConfig] = useState<AccessConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Mount fetch via .then() to keep setState off the effect's sync
  // path (react-hooks/set-state-in-effect). Subsequent updates flow
  // through applyStored from the editor child below.
  useEffect(() => {
    let cancelled = false
    getAccessConfig()
      .then((res) => {
        if (!cancelled) setConfig(res.data)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function applyStored(stored: AccessConfig['stored']) {
    setConfig((prev) => (prev ? { ...prev, stored } : prev))
  }

  return (
    <section className="admin-section">
      <h3>Access lists</h3>
      <p className="help">
        Who can sign in (Allowed) and who can edit system-wide config
        (Admins). Entries can be exact emails (<code>name@example.com</code>)
        or domain wildcards (<code>@example.com</code>). The effective
        list is the union of the two columns below: <em>break-glass</em>
        entries baked into <code>functions/.env</code> at deploy time
        are always honored, so removing every Firestore admin can't
        lock you out.
      </p>
      {error && <div className="error">{error}</div>}
      {config === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <AccessListEditor
            list="allowed"
            title="Allowed users"
            envEntries={config.env.allowedEmails}
            storedEntries={config.stored.allowedEmails}
            onStoredChange={applyStored}
          />
          <AccessListEditor
            list="admin"
            title="Admins"
            envEntries={config.env.adminEmails}
            storedEntries={config.stored.adminEmails}
            onStoredChange={applyStored}
          />
        </>
      )}
    </section>
  )
}

function AccessListEditor({
  list,
  title,
  envEntries,
  storedEntries,
  onStoredChange,
}: {
  list: AccessList
  title: string
  envEntries: string[]
  storedEntries: string[]
  onStoredChange: (stored: AccessConfig['stored']) => void
}) {
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleAdd() {
    const entry = draft.trim().toLowerCase()
    if (!entry) return
    if (!entryIsValid(entry)) {
      setError('Use "name@example.com" or "@example.com" (domain wildcard).')
      return
    }
    setAdding(true)
    setError(null)
    try {
      const res = await addAccessEntry({ list, entry })
      onStoredChange(res.data.stored)
      setDraft('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  async function handleRemove(entry: string) {
    setRemoving(entry)
    setError(null)
    try {
      const res = await removeAccessEntry({ list, entry })
      onStoredChange(res.data.stored)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="access-list-editor">
      <h4>{title}</h4>
      <div className="access-list-columns">
        <div className="access-list-col">
          <div className="access-list-col-label">From <code>.env</code> (break-glass)</div>
          {envEntries.length === 0 ? (
            <p className="muted">None — Firestore-only.</p>
          ) : (
            <ul className="access-entry-list">
              {envEntries.map((e) => (
                <li key={e} className="access-entry env">
                  <span className="access-entry-text">{e}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="access-list-col">
          <div className="access-list-col-label">From Firestore (editable)</div>
          {storedEntries.length === 0 ? (
            <p className="muted">None added yet.</p>
          ) : (
            <ul className="access-entry-list">
              {storedEntries.map((e) => (
                <li key={e} className="access-entry">
                  <span className="access-entry-text">{e}</span>
                  <button
                    type="button"
                    className="access-entry-remove"
                    onClick={() => void handleRemove(e)}
                    disabled={removing !== null || adding}
                    title={`Remove "${e}"`}
                    aria-label={`Remove "${e}"`}
                  >
                    {removing === e ? '…' : <Icon name="x" size={13} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="access-add">
            <input
              type="text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                if (error) setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleAdd()
                }
              }}
              placeholder="name@example.com or @example.com"
              disabled={adding}
            />
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={adding || !draft.trim()}
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  )
}

function RejectionReasonsSection() {
  const [reasons, setReasons] = useState<CommonReason[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removingText, setRemovingText] = useState<string | null>(null)
  // Inline-edit state: which chip is being renamed + the draft text.
  // Keyed by the chip's current text. Collision errors live per-row.
  const [editingText, setEditingText] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [collisionError, setCollisionError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Mount fetch via .then() to keep setState off the effect's sync
  // path (react-hooks/set-state-in-effect). Post-remove / post-rename
  // updates flow through setReasons() in the handlers below.
  useEffect(() => {
    let cancelled = false
    getRejectionReasons()
      .then((res) => {
        if (!cancelled) setReasons(res.data.common)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Auto-focus the rename input as soon as it appears. The ref check
  // is defensive — React may schedule the input mount across a tick.
  useEffect(() => {
    if (editingText !== null) {
      const t = setTimeout(() => inputRef.current?.select(), 0)
      return () => clearTimeout(t)
    }
  }, [editingText])

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

  function startEdit(text: string) {
    setEditingText(text)
    setDraft(text)
    setCollisionError(null)
  }

  function cancelEdit() {
    setEditingText(null)
    setDraft('')
    setCollisionError(null)
  }

  async function commitEdit() {
    if (editingText === null) return
    const oldText = editingText
    const newText = draft.trim()
    if (!newText || newText === oldText) {
      cancelEdit()
      return
    }
    setRenaming(true)
    setError(null)
    setCollisionError(null)
    try {
      const res = await renameCommonReason({ oldText, newText })
      if (res.data.collisionWith) {
        setCollisionError(
          `"${res.data.collisionWith}" already covers this — delete one or pick a different name.`,
        )
      } else {
        setReasons(res.data.common)
        cancelEdit()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRenaming(false)
    }
  }

  return (
    <section className="admin-section">
      <h3>Reject-reason chips (system-wide pool)</h3>
      <p className="help">
        The clickable chips that show up on the reject-rationale picker.
        Seeded with a handful of defaults; grows automatically as users
        type freeform reasons (Claude distills the freeform log into new
        chip-worthy categories after every few entries). Click a chip's
        text to rename it. Removing a chip pulls it from every user's
        picker immediately.
      </p>
      {error && <div className="error">{error}</div>}
      {reasons === null ? (
        <p className="muted">Loading…</p>
      ) : reasons.length === 0 ? (
        <p className="muted">No chips yet — the pool will fill in as users reject songs and add reasons.</p>
      ) : (
        <ul className="admin-reason-list">
          {(() => {
            const activeAi = activeAiChipTexts(reasons)
            return reasons.map((r) => {
              const isEditing = editingText === r.text
              // "Proto" = an AI-distilled chip that hasn't earned a
              // user-facing slot yet. Visually dimmed so the admin can
              // see at a glance which chips are live vs. queued.
              const isProto = r.source === 'ai' && !activeAi.has(r.text)
              return (
              <li
                key={r.text}
                className={`admin-reason-item${isProto ? ' is-proto' : ''}`}
              >
                {isEditing ? (
                  <input
                    ref={inputRef}
                    className="admin-reason-edit"
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value)
                      if (collisionError) setCollisionError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitEdit()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelEdit()
                      }
                    }}
                    onBlur={() => {
                      // Blur saves rather than cancels — matches
                      // common form-field convention. Esc is the
                      // explicit "discard" affordance.
                      void commitEdit()
                    }}
                    disabled={renaming}
                    aria-label={`Rename "${r.text}"`}
                  />
                ) : (
                  <button
                    type="button"
                    className="admin-reason-text"
                    onClick={() => startEdit(r.text)}
                    title="Click to rename this chip"
                  >
                    {r.text}
                    <Icon
                      name="edit"
                      size={11}
                      className="admin-reason-edit-icon"
                    />
                  </button>
                )}
                <span
                  className="admin-reason-count"
                  title={`Used ${r.useCount} time${r.useCount === 1 ? '' : 's'}`}
                >
                  × {r.useCount}
                </span>
                <span className={`admin-reason-source source-${r.source}`}>
                  {sourceLabel(r.source)}
                </span>
                {isProto && (
                  <span
                    className="admin-reason-proto"
                    title="Distilled but not yet in the top — hidden from the user picker until usage moves it up"
                  >
                    proto
                  </span>
                )}
                <span className="admin-reason-date">
                  {formatAddedAt(r.addedAt)}
                </span>
                <button
                  type="button"
                  className="admin-reason-remove"
                  onClick={() => void handleRemove(r.text)}
                  disabled={removingText !== null || renaming}
                  title="Remove this chip from the global pool"
                  aria-label={`Remove "${r.text}"`}
                >
                  {removingText === r.text ? '…' : <Icon name="x" size={13} />}
                </button>
                {isEditing && collisionError && (
                  <div className="admin-reason-collision">
                    {collisionError}
                  </div>
                )}
              </li>
              )
            })
          })()}
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
  // Reset the draft when the parent reloads config (e.g. after save or
  // reset). React's recommended "adjust state during render" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // — comparing against lastInitial inline and calling setState during
  // render — avoids the effect + setState combo that
  // react-hooks/set-state-in-effect flags.
  const [lastInitial, setLastInitial] = useState(initial)
  const [draft, setDraft] = useState(initial)
  if (initial !== lastInitial) {
    setLastInitial(initial)
    setDraft(initial)
  }
  const [saving, setSaving] = useState<'save' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const copy = COPY[type]

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
