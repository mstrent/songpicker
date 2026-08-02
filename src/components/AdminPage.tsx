import React, { useEffect, useState } from 'react'
import {
  addAccessEntry,
  getAccessConfig,
  getAdminPromptConfig,
  getMetrics,
  getRotationConfig,
  removeAccessEntry,
  saveAdminPromptConfig,
  saveRotationConfig,
  type AccessConfig,
  type AccessList,
  type AdminPromptConfig,
  type PromptType,
  type RotationConfig,
  type UserMetricsView,
} from '../lib/api'
import { Icon } from './Icon'

const PROMPT_LABEL: Record<PromptType, string> = {
  role: 'AI persona (system-wide default)',
  structure: 'AI service-flow prompt (system-wide default)',
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
      <h2>Admin</h2>

      <AccessSection />

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

      <RotationSection />

      <MetricsSection />

      <section className="admin-section read-only admin-reference">
        <details>
          <summary>Reference: prompts &amp; tool schemas (read-only)</summary>
          <div className="admin-reference-body">
            <h4>Technical requirements</h4>
            <details className="hardcoded-display">
              <summary>View technical requirements</summary>
              <pre>{config.technical}</pre>
            </details>

            <h4>AI tooling prompts</h4>
            {config.tooling.tools.map((t) => (
              <React.Fragment key={t.name}>
                <details className="hardcoded-display">
                  <summary>
                    <code>{t.name}</code> tool description
                  </summary>
                  <pre>{t.description}</pre>
                </details>
                <details className="hardcoded-display">
                  <summary>
                    <code>{t.name}</code> input schema{' '}
                    <em>(field descriptions)</em>
                  </summary>
                  <pre>{JSON.stringify(t.inputSchema, null, 2)}</pre>
                </details>
              </React.Fragment>
            ))}
            <details className="hardcoded-display">
              <summary>Auto-refresh nudge</summary>
              <pre>{config.tooling.autoRefreshNudge}</pre>
            </details>
            <h4>Song classifier prompts</h4>
            <details className="hardcoded-display">
              <summary>Classifier system prompt</summary>
              <pre>{config.tooling.classifier.systemPrompt}</pre>
            </details>
            <details className="hardcoded-display">
              <summary>
                <code>{config.tooling.classifier.tool.name}</code> tool description
              </summary>
              <pre>{config.tooling.classifier.tool.description}</pre>
            </details>
            <details className="hardcoded-display">
              <summary>
                <code>{config.tooling.classifier.tool.name}</code> input schema{' '}
                <em>(field descriptions)</em>
              </summary>
              <pre>
                {JSON.stringify(config.tooling.classifier.tool.inputSchema, null, 2)}
              </pre>
            </details>

            <h4>Per-turn prompt preview</h4>
            <details className="hardcoded-display">
              <summary>
                Composed system prompt{' '}
                <em>(default role + technical requirements)</em>
              </summary>
              <pre>{config.tooling.composedSystemPromptPreview}</pre>
            </details>
            <details className="hardcoded-display">
              <summary>
                Sample user message — stable half{' '}
                <em>(prompt-cached, 1h TTL)</em>
              </summary>
              <pre>{config.tooling.sampleUserMessage.stable}</pre>
            </details>
            <details className="hardcoded-display">
              <summary>
                Sample user message — volatile half{' '}
                <em>(fresh each turn)</em>
              </summary>
              <pre>{config.tooling.sampleUserMessage.volatile}</pre>
            </details>
          </div>
        </details>
      </section>
    </div>
  )
}

function MetricsSection() {
  const [users, setUsers] = useState<UserMetricsView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Mount fetch via .then() to keep setState off the synchronous effect
  // path (react-hooks/set-state-in-effect) — same shape AccessSection uses.
  useEffect(() => {
    let cancelled = false
    getMetrics()
      .then((res) => {
        if (!cancelled) setUsers(res.data.users)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="admin-section read-only admin-reference">
      <details>
        <summary>Usage metrics (diagnostic)</summary>
        <div className="admin-reference-body">
          {error && <div className="error">{error}</div>}
          {users === null ? (
            error ? null : <p className="muted">Loading…</p>
          ) : users.length === 0 ? (
            <p className="muted">No activity recorded yet.</p>
          ) : (
            <table className="metrics-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Sign-ins</th>
                  <th>Plans opened</th>
                  <th>AI suggestions</th>
                  <th>Commits</th>
                  <th>Clears</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.uid}>
                    <td>{u.email}</td>
                    <td>{u.signIns}</td>
                    <td>{u.plansOpened}</td>
                    <td>{u.aiSuggestions}</td>
                    <td>{u.slotCommits}</td>
                    <td>{u.slotClears}</td>
                    <td title={u.firstSeenAt ?? ''}>{formatRelative(u.firstSeenAt)}</td>
                    <td title={u.lastSeenAt ?? ''}>{formatRelative(u.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </details>
    </section>
  )
}

// Compact relative-time formatter for the metrics table. Returns
// short forms ("2h ago", "3d ago") for recent times and a date
// stamp for anything older than ~30 days. ISO input → display string.
function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const diffMs = Date.now() - then
  if (diffMs < 0) return 'just now'
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(iso).toISOString().slice(0, 10)
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

/** Song-rotation windows. Two numbers rather than a prompt, because
 *  they also drive how far back Planning Center is scanned — the
 *  suggester's "Recently sung" block is generated from them, so the
 *  wording the model sees can't drift from the values set here. */
function RotationSection() {
  const [config, setConfig] = useState<RotationConfig | null>(null)
  const [hard, setHard] = useState('')
  const [reduced, setReduced] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getRotationConfig()
      .then((res) => {
        setConfig(res.data)
        setHard(String(res.data.windows.hardBlockDays))
        setReduced(String(res.data.windows.reducedWeightDays))
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  const hardNum = Number(hard)
  const reducedNum = Number(reduced)
  // Mirrors parseRotationWindows on the server so the admin gets the
  // reason inline instead of via a round trip. The server is still the
  // real gate.
  const validation =
    !Number.isInteger(hardNum) || hardNum < 1
      ? 'Hard-block window must be a whole number of days, at least 1.'
      : !Number.isInteger(reducedNum)
        ? 'Reduced-weight window must be a whole number of days.'
        : reducedNum <= hardNum
          ? 'Reduced-weight window must be larger than the hard-block window.'
          : config && reducedNum > config.maxReducedWeightDays
            ? `Reduced-weight window can be at most ${config.maxReducedWeightDays} days.`
            : null

  const dirty =
    config !== null &&
    (hardNum !== config.windows.hardBlockDays ||
      reducedNum !== config.windows.reducedWeightDays)

  async function save() {
    if (validation || !dirty) return
    setSaving(true)
    setError(null)
    try {
      const res = await saveRotationConfig({
        hardBlockDays: hardNum,
        reducedWeightDays: reducedNum,
      })
      setConfig((prev) => (prev ? { ...prev, windows: res.data.windows } : prev))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="admin-section">
      <h3>Song rotation</h3>
      <p className="muted">
        How recently a song was sung before the AI stops suggesting it.
        Applies to the whole service type&rsquo;s history in Planning
        Center.
      </p>
      {error && <div className="error">{error}</div>}
      {config === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="rotation-fields">
            <label>
              <span>Don&rsquo;t suggest within</span>
              <input
                type="number"
                min={1}
                value={hard}
                onChange={(e) => setHard(e.target.value)}
              />
              <span>days</span>
            </label>
            <label>
              <span>Suggest reluctantly within</span>
              <input
                type="number"
                min={2}
                max={config.maxReducedWeightDays}
                value={reduced}
                onChange={(e) => setReduced(e.target.value)}
              />
              <span>days</span>
            </label>
          </div>
          {validation && <div className="error">{validation}</div>}
          <div className="rotation-actions">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty || validation !== null}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="muted">Saved</span>}
            <span className="muted">
              Defaults: {config.defaults.hardBlockDays} and{' '}
              {config.defaults.reducedWeightDays} days
            </span>
          </div>
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
      <h3>{PROMPT_LABEL[type]}</h3>
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
