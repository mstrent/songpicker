import { useState } from 'react'
import { savePcoCredentials } from '../lib/api'

interface Props {
  onSaved: () => void
}

export function PcoSetup({ onSaved }: Props) {
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!appId.trim() || !secret.trim()) return
    setSaving(true)
    setError(null)
    try {
      await savePcoCredentials({ appId: appId.trim(), secret: secret.trim() })
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="pco-setup">
      <h2>Connect Planning Center</h2>
      <p>
        Songpicker needs a Personal Access Token from your Planning Center
        account so it can pull your service plans and song library. It's stored
        encrypted on the server — only your account can use it.
      </p>
      <ol className="instructions">
        <li>
          Open{' '}
          <a
            href="https://api.planningcenteronline.com/oauth/applications"
            target="_blank"
            rel="noopener noreferrer"
          >
            api.planningcenteronline.com/oauth/applications ↗
          </a>
        </li>
        <li>Scroll down to <strong>Personal Access Tokens</strong>.</li>
        <li>Click <strong>New Personal Access Token</strong>, name it "songpicker".</li>
        <li>Paste the <strong>Application ID</strong> and <strong>Secret</strong> into the fields below.</li>
      </ol>
      <form onSubmit={handleSubmit}>
        <label>
          <span>Application ID</span>
          <input
            type="text"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
            required
          />
        </label>
        <label>
          <span>Secret</span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={saving || !appId.trim() || !secret.trim()}>
          {saving ? 'Verifying…' : 'Connect Planning Center'}
        </button>
      </form>
    </div>
  )
}
