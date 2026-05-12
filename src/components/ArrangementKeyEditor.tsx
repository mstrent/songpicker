import { useState } from 'react'
import {
  listSongArrangements,
  setSlotArrangementKey,
  type PlanItem,
  type SongArrangement,
} from '../lib/api'

interface Props {
  serviceTypeId: string
  planId: string
  item: PlanItem
  onSaved: () => void
}

// Inline "Key X" chip on a filled service-order slot. Clicking it opens
// a small panel with arrangement + key dropdowns so the user can change
// either without leaving the page. Arrangements are fetched lazily on
// first open so we don't spam the PCO API for every visible slot.
export function ArrangementKeyEditor({ serviceTypeId, planId, item, onSaved }: Props) {
  const [open, setOpen] = useState(false)
  const [arrangements, setArrangements] = useState<SongArrangement[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedArrId, setSelectedArrId] = useState<string | null>(item.arrangementId)
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(item.keyId)
  const [saving, setSaving] = useState(false)

  async function openEditor() {
    setOpen(true)
    if (arrangements != null || !item.songId) return
    setLoading(true)
    setError(null)
    try {
      const res = await listSongArrangements({ songId: item.songId })
      setArrangements(res.data.arrangements)
      // Pick a sensible default if the slot's stored arrangement isn't
      // in the list (rare but possible if arrangements changed).
      if (!selectedArrId && res.data.arrangements.length > 0) {
        const fallback = res.data.arrangements[0]
        setSelectedArrId(fallback.id)
        if (!selectedKeyId && fallback.keys.length > 0) {
          setSelectedKeyId(fallback.keys[0].id)
        }
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    if (!selectedArrId) return
    setSaving(true)
    setError(null)
    try {
      await setSlotArrangementKey({
        serviceTypeId,
        planId,
        itemId: item.id,
        arrangementId: selectedArrId,
        keyId: selectedKeyId ?? undefined,
      })
      setOpen(false)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const selectedArr = arrangements?.find((a) => a.id === selectedArrId)
  const dirty =
    selectedArrId !== item.arrangementId || selectedKeyId !== item.keyId

  return (
    <span className="arr-key-editor">
      <button
        type="button"
        className={`meta-chip arr-key-chip${open ? ' is-open' : ''}`}
        onClick={() => (open ? setOpen(false) : void openEditor())}
        aria-expanded={open}
        title="Change arrangement or key"
      >
        Key <strong>{item.keyName ?? '?'}</strong>
        <span className="chev" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="arr-key-panel" role="dialog" aria-label="Arrangement and key">
          {loading && <div className="loading">Loading arrangements…</div>}
          {error && <div className="error">{error}</div>}
          {arrangements && arrangements.length === 0 && !loading && (
            <div className="empty">No arrangements found for this song.</div>
          )}
          {arrangements && arrangements.length > 0 && (
            <>
              <label>
                <span>Arrangement</span>
                <select
                  value={selectedArrId ?? ''}
                  onChange={(e) => {
                    const arrId = e.target.value
                    setSelectedArrId(arrId)
                    const arr = arrangements.find((a) => a.id === arrId)
                    // Reset key to the new arrangement's first key (the
                    // old keyId wouldn't belong to the new arrangement).
                    setSelectedKeyId(arr?.keys[0]?.id ?? null)
                  }}
                >
                  {arrangements.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.chordChartKey ? ` (${a.chordChartKey})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Key</span>
                <select
                  value={selectedKeyId ?? ''}
                  onChange={(e) => setSelectedKeyId(e.target.value || null)}
                  disabled={!selectedArr || selectedArr.keys.length === 0}
                >
                  <option value="">(no key)</option>
                  {selectedArr?.keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !selectedArrId || !dirty}
                  title={dirty ? 'Save changes' : 'No changes yet'}
                >
                  {saving ? 'Saving…' : 'Apply'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setOpen(false)}
                  disabled={saving}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </span>
  )
}
