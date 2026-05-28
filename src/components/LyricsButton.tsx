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
   *  `icon` is icon-only at iconbtn-sm size. The chip variant sits
   *  inline at the end of the candidate's chorus-snippet text, so the
   *  label keeps it readable alongside the snippet. */
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
  onRecheck?: () => Promise<{ plainLyrics: string | null; artistName: string | null } | null>
  /** Pre-fetched lyrics from the enriched candidate pool. When
   *  provided, the popover renders these directly and skips its own
   *  getLyrics fetch — every candidate has been through enrichSnippets
   *  by the time its Lyrics chip is clickable, so this is the common
   *  case. Slot-row popovers (PCO songs not in the candidate pool)
   *  pass undefined and fall back to getLyrics. */
  precomputed?: { plainLyrics: string | null; artistName: string | null }
}

export function LyricsPopover({
  song,
  onClose,
  onRecheck,
  precomputed,
}: LyricsPopoverProps) {
  const [loading, setLoading] = useState(!precomputed)
  const [result, setResult] = useState<LyricsResult | null>(() =>
    precomputed
      ? {
          found: !!precomputed.plainLyrics,
          plainLyrics: precomputed.plainLyrics,
          instrumental: false,
          artistName: precomputed.artistName,
          source: 'lrclib',
          fetchedAt: Date.now(),
          fromCache: true,
        }
      : null,
  )
  const [error, setError] = useState<string | null>(null)
  /** Tracks the song the in-flight callable is for. If the user clicks
   *  a different chip while one fetch is mid-flight, we discard its
   *  result rather than overwrite the newer song's state. */
  const currentId = useRef(song.id)

  const popoverRef = useRef<HTMLDivElement | null>(null)
  /** When the user has dragged the popover, we override the docked
   *  position with these viewport-relative coords. Persists across
   *  song swaps but resets when the popover closes (component unmounts). */
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef<{
    mouseX: number
    mouseY: number
    popX: number
    popY: number
  } | null>(null)

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

  // Fetch on mount / song change. When the parent supplied precomputed
  // lyrics (the candidate pool case), skip the network call and seed
  // result from the props.
  useEffect(() => {
    if (precomputed) {
      currentId.current = song.id
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResult({
        found: !!precomputed.plainLyrics,
        plainLyrics: precomputed.plainLyrics,
        instrumental: false,
        artistName: precomputed.artistName,
        source: 'lrclib',
        fetchedAt: Date.now(),
        fromCache: true,
      })
      setLoading(false)
      setError(null)
      return
    }
    void load(false)
  }, [song.id, load, precomputed])

  // Escape closes. Clicks outside the popover ALSO close — except
  // clicks on a .lyrics-chip / .iconbtn-lyrics, which swap the
  // popover's content to the newly-clicked song without dismissing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Element | null
      if (!t) return
      if (popoverRef.current?.contains(t)) return
      // Only dismiss on clicks in genuine empty space. Any click that
      // lands on an interactive element (buttons, links, inputs,
      // drag handles, key/menu chips, etc.) keeps the popover open
      // so the user can re-order songs, change keys, ask for more AI
      // suggestions, etc. while still reading lyrics. Clicks on a
      // .lyrics-chip in particular get caught by the `button` half
      // of this selector and swap the popover's content via the
      // trigger's own onClick.
      if (
        t.closest(
          'button, a, input, textarea, select, label, [role="button"], [role="link"], [role="menuitem"], [role="menu"], [role="combobox"], [role="listbox"], [role="textbox"], [draggable="true"], [contenteditable="true"]',
        )
      ) {
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDocMouseDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDocMouseDown)
    }
  }, [onClose])

  // Drag-to-reposition via the header. The window mousemove + mouseup
  // listeners are attached synchronously inside the mousedown handler
  // (rather than via a useEffect on `dragging`) so the listener is
  // already live by the time the very next mousemove event fires —
  // a useEffect-gated attach would race against the React commit.
  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Don't start drag if the click was on the close button or any
      // interactive child of the header.
      const t = e.target as Element | null
      if (t?.closest('.lyrics-popover-close, button, a')) return
      const rect = popoverRef.current?.getBoundingClientRect()
      if (!rect) return
      dragStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        popX: rect.left,
        popY: rect.top,
      }
      setDragging(true)

      function onMove(ev: MouseEvent) {
        const start = dragStartRef.current
        const popover = popoverRef.current
        if (!start || !popover) return
        const r = popover.getBoundingClientRect()
        const newX = start.popX + (ev.clientX - start.mouseX)
        const newY = start.popY + (ev.clientY - start.mouseY)
        // Keep at least the title bar visible — clamp so the popover
        // can't be dragged off the screen edges.
        const clampedX = Math.max(
          8,
          Math.min(window.innerWidth - r.width - 8, newX),
        )
        const clampedY = Math.max(
          8,
          Math.min(window.innerHeight - 56, newY),
        )
        setPosition({ x: clampedX, y: clampedY })
      }
      function onUp() {
        setDragging(false)
        dragStartRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)

      e.preventDefault()
    },
    [],
  )

  const dockedClass = position
    ? 'lyrics-popover-positioned'
    : `lyrics-popover-dock-${song.dockSide}`
  const inlineStyle = position
    ? { top: position.y, left: position.x, right: 'auto' as const }
    : undefined

  return (
    <div
      ref={popoverRef}
      className={`lyrics-popover ${dockedClass}${dragging ? ' lyrics-popover-dragging' : ''}`}
      style={inlineStyle}
      role="region"
      aria-label={`Lyrics for ${song.title}`}
    >
      <div
        className="lyrics-popover-header"
        onMouseDown={handleHeaderMouseDown}
      >
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
              {result.found && result.artistName && (
                <span className="lyrics-popover-artist">
                  {' · '}
                  <span className="lyrics-popover-artist-label">via</span>{' '}
                  {result.artistName}
                </span>
              )}
            </span>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                if (onRecheck) {
                  setLoading(true)
                  setResult(null)
                  onRecheck().then((r) => {
                    if (currentId.current !== song.id) return
                    if (r) {
                      setResult({
                        found: !!r.plainLyrics,
                        plainLyrics: r.plainLyrics,
                        instrumental: false,
                        artistName: r.artistName,
                        source: 'lrclib',
                        fetchedAt: Date.now(),
                        fromCache: false,
                      })
                    }
                    setLoading(false)
                  }).catch(() => {
                    if (currentId.current === song.id) {
                      setError('Re-check failed')
                      setLoading(false)
                    }
                  })
                } else {
                  void load(true)
                }
              }}
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
