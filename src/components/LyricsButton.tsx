import { useCallback, useEffect, useRef, useState } from 'react'

import { getLyrics, type LyricsResult } from '../lib/api'

interface LyricsButtonProps {
  title: string
  author?: string | null
  /** Visual treatment — `chip` is a labeled pill ("Lyrics" + icon),
   *  `icon` is icon-only at iconbtn-sm size. The chip variant carries
   *  its label because it replaces the chorus-snippet text that
   *  active candidate cards used to show — keeping a label there
   *  preserves recognizability where the row used to have prose. */
  variant: 'chip' | 'icon'
}

function LyricsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4h10M3 8h10M3 12h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function LyricsButton({ title, author, variant }: LyricsButtonProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<LyricsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const cleanAuthor = author?.trim() || undefined

  const load = useCallback(
    async (forceRefresh: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const res = await getLyrics({
          title: title.trim(),
          author: cleanAuthor,
          forceRefresh,
        })
        setResult(res.data)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to fetch lyrics'
        setError(message)
      } finally {
        setLoading(false)
      }
    },
    [title, cleanAuthor],
  )

  const handleOpen = useCallback(() => {
    setOpen(true)
    if (!result) void load(false)
  }, [result, load])

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [])

  // Escape closes; click outside the modal card closes.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    function onClick(e: MouseEvent) {
      const el = dialogRef.current
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [open])

  return (
    <>
      {variant === 'chip' ? (
        <button
          type="button"
          className="lyrics-chip"
          title="View lyrics"
          aria-label={`View lyrics for ${title}`}
          onClick={handleOpen}
        >
          <LyricsIcon />
          <span>Lyrics</span>
        </button>
      ) : (
        <button
          type="button"
          className="iconbtn iconbtn-sm iconbtn-lyrics"
          title="View lyrics"
          aria-label={`View lyrics for ${title}`}
          onClick={handleOpen}
        >
          <LyricsIcon />
        </button>
      )}
      {open && (
        <div className="lyrics-modal-backdrop" role="presentation">
          <div
            className="lyrics-modal-card"
            role="dialog"
            aria-modal="true"
            aria-label={`Lyrics for ${title}`}
            ref={dialogRef}
          >
            <header className="lyrics-modal-header">
              <div className="lyrics-modal-title">
                <strong>{title}</strong>
                {cleanAuthor && <span className="lyrics-modal-author"> — {cleanAuthor}</span>}
              </div>
              <button
                type="button"
                className="iconbtn iconbtn-sm"
                onClick={handleClose}
                aria-label="Close lyrics"
                title="Close"
              >
                ×
              </button>
            </header>
            <div className="lyrics-modal-body">
              {loading && <p className="lyrics-status">Loading…</p>}
              {!loading && error && (
                <p className="lyrics-status lyrics-status-error">
                  Couldn't fetch lyrics: {error}
                </p>
              )}
              {!loading && !error && result && result.found && result.instrumental && (
                <p className="lyrics-status">Instrumental — no lyrics.</p>
              )}
              {!loading && !error && result && result.found && !result.instrumental && !result.plainLyrics && (
                <p className="lyrics-status">Found on LRCLIB, but no lyric text available.</p>
              )}
              {!loading && !error && result && result.found && !result.instrumental && result.plainLyrics && (
                <pre className="lyrics-text">{result.plainLyrics}</pre>
              )}
              {!loading && !error && result && !result.found && (
                <div className="lyrics-status lyrics-status-empty">
                  <p>Not found on LRCLIB.</p>
                  <p className="lyrics-status-hint">
                    Try PraiseCharts for chart and lyric resources.
                  </p>
                </div>
              )}
            </div>
            <footer className="lyrics-modal-footer">
              {result && (
                <>
                  <span className="lyrics-modal-source">
                    Source: LRCLIB
                    {result.fromCache ? ' (cached)' : ''}
                  </span>
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => void load(true)}
                    disabled={loading}
                  >
                    Re-check LRCLIB
                  </button>
                </>
              )}
            </footer>
          </div>
        </div>
      )}
    </>
  )
}
