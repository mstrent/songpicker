import { useCallback, useEffect, useRef, useState } from 'react'

import { getLyrics, type LyricsResult } from '../lib/api'

/** Identity of the song whose lyrics are currently being viewed.
 *  `id` is a stable key for React reconciliation when the user
 *  swaps to a different song (lets the popover body cross-fade).
 *  `dockSide` is the OPPOSITE side from where the chip was clicked
 *  — clicks from the candidates column (right) dock the popover
 *  left, and vice versa, so the user's working column stays visible. */
export interface ActiveLyrics {
  id: string
  title: string
  author: string | null
  dockSide: 'left' | 'right'
}

interface LyricsTriggerProps {
  title: string
  author?: string | null
  /** Visual treatment — `chip` is a labeled pill ("Lyrics" + icon),
   *  `icon` is icon-only at iconbtn-sm size. The chip variant carries
   *  its label because it replaces the chorus-snippet text that
   *  active candidate cards used to show — keeping a label there
   *  preserves recognizability where the row used to have prose. */
  variant: 'chip' | 'icon'
  /** Called with the song to display. Parent owns the popover state
   *  so the same popover instance can swap content between songs
   *  without dismiss-and-reopen friction. */
  onActivate: (song: ActiveLyrics) => void
}

function songId(title: string, author: string | null): string {
  return `${title}::${author ?? ''}`
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

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2 2L10 10M10 2L2 10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function LyricsTrigger({
  title,
  author,
  variant,
  onActivate,
}: LyricsTriggerProps) {
  const cleanAuthor = author?.trim() || null
  const cleanTitle = title.trim()
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Dock the popover on the opposite side of the chip so the column
    // the user is reading stays visible. Left-half chip → popover docks
    // right; right-half chip → popover docks left.
    const rect = e.currentTarget.getBoundingClientRect()
    const chipCenterX = rect.left + rect.width / 2
    const dockSide: 'left' | 'right' =
      chipCenterX < window.innerWidth / 2 ? 'right' : 'left'
    onActivate({
      id: songId(cleanTitle, cleanAuthor),
      title: cleanTitle,
      author: cleanAuthor,
      dockSide,
    })
  }

  if (variant === 'chip') {
    return (
      <button
        type="button"
        className="lyrics-chip"
        title="View lyrics"
        aria-label={`View lyrics for ${cleanTitle}`}
        onClick={handleClick}
      >
        <LyricsIcon />
        <span>Lyrics</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      className="iconbtn iconbtn-sm iconbtn-lyrics"
      title="View lyrics"
      aria-label={`View lyrics for ${cleanTitle}`}
      onClick={handleClick}
    >
      <LyricsIcon />
    </button>
  )
}

interface LyricsPopoverProps {
  song: ActiveLyrics
  onClose: () => void
}

export function LyricsPopover({ song, onClose }: LyricsPopoverProps) {
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState<LyricsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Tracks the song the in-flight callable is for. If the user clicks
   *  a different chip while one fetch is mid-flight, we discard its
   *  result rather than overwrite the newer song's state. */
  const currentId = useRef(song.id)

  const load = useCallback(
    async (forceRefresh: boolean) => {
      currentId.current = song.id
      setLoading(true)
      setError(null)
      if (forceRefresh) setResult(null)
      try {
        const res = await getLyrics({
          title: song.title,
          author: song.author ?? undefined,
          forceRefresh,
        })
        if (currentId.current === song.id) setResult(res.data)
      } catch (err) {
        if (currentId.current === song.id) {
          setError(err instanceof Error ? err.message : 'Failed to fetch lyrics')
        }
      } finally {
        if (currentId.current === song.id) setLoading(false)
      }
    },
    [song.id, song.title, song.author],
  )

  // Re-fetch whenever the song changes (including initial mount).
  useEffect(() => {
    setResult(null)
    void load(false)
  }, [song.id, load])

  // Escape closes. No click-outside dismissal — the popover is
  // intentionally non-blocking; user keeps it open while scanning
  // through candidate songs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className={`lyrics-popover lyrics-popover-dock-${song.dockSide}`}
      role="region"
      aria-label={`Lyrics for ${song.title}`}
    >
      <div className="lyrics-popover-header">
        <div className="lyrics-popover-title">
          <strong>{song.title}</strong>
          {song.author && (
            <span className="lyrics-popover-author">{song.author}</span>
          )}
        </div>
        <button
          type="button"
          className="iconbtn iconbtn-sm lyrics-popover-close"
          onClick={onClose}
          aria-label="Close lyrics"
          title="Close"
        >
          <CloseIcon />
        </button>
      </div>
      {/* key={song.id} forces a remount on song change so the body
          re-runs its entry animation — content visibly refreshes when
          the user clicks a different chip. */}
      <div className="lyrics-popover-body" key={song.id}>
        {loading && <p className="lyrics-status">Loading…</p>}
        {!loading && error && (
          <p className="lyrics-status lyrics-status-error">
            Couldn't fetch lyrics: {error}
          </p>
        )}
        {!loading && !error && result && result.found && result.instrumental && (
          <p className="lyrics-status">Instrumental — no lyrics.</p>
        )}
        {!loading && !error && result && result.found && !result.instrumental && (
          result.plainLyrics?.trim() ? (
            <pre className="lyrics-text">{result.plainLyrics.trim()}</pre>
          ) : (
            <p className="lyrics-status">
              Found on LRCLIB, but no lyric text available.
            </p>
          )
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
      <div className="lyrics-popover-footer">
        {result && (
          <>
            <span className="lyrics-popover-source">
              LRCLIB{result.fromCache ? ' · cached' : ''}
            </span>
            <button
              type="button"
              className="btn-link"
              onClick={() => void load(true)}
              disabled={loading}
            >
              Re-check
            </button>
          </>
        )}
      </div>
    </div>
  )
}
