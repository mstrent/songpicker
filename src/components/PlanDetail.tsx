import React, { useEffect, useRef, useState } from 'react'
import { isSongSlot } from '../lib/songSlots'
import {
  compileClearSlot,
  compileCommitToSlot,
  compileDropCandidateOnSlot,
} from '../lib/planActions/compile'
import { usePlanData } from '../lib/usePlanData'
import { useCandidatePool } from '../lib/useCandidatePool'
import { usePromptConfig } from '../lib/usePromptConfig'
import { ArrangementKeyEditor } from './ArrangementKeyEditor'
import { PromptBody } from './PromptBody'
import { PromptPill } from './PromptPill'
import { Icon } from './Icon'
import { EmptyState } from './EmptyState'
import { SongLookupLinks } from './SongLookupLinks'
import { LyricsTrigger, LyricsPopover, type ActiveLyrics } from './LyricsButton'
import { lastScheduledDisplay } from '../lib/lastScheduled'

type OpenPrompt = 'role' | 'structure' | null

const PROMPT_COPY = {
  role: {
    label: 'AI persona',
    help: "Describe the AI's persona — who it is, how it should think about your service, the kind of church you lead, the theological frame you prefer, etc. The technical JSON-format requirements are added behind the scenes, so you can edit freely without breaking output.",
  },
  structure: {
    label: 'AI service-flow prompt',
    help: 'Extra context the AI receives on every Suggest call, shaping how songs are distributed across the service (opener, mid-service, closer, etc.).',
  },
}

interface Props {
  serviceTypeId: string
  planId: string
}

function formatSnippet(text: string): string {
  return text.replace(/\n+/g, ' / ')
}

function snippetTooltip(
  source: string | undefined,
): string | undefined {
  if (source === 'lrclib' || source === 'haiku-extract') return undefined
  if (source === 'haiku-generate')
    return 'Lyrics recalled from AI — may be inaccurate.'
  return 'AI-sourced lyrics. May be inaccurate.'
}

export function PlanDetail({ serviceTypeId, planId }: Props) {
  // The "model" lives in two hooks reflecting the PCO/candidate
  // split (see CLAUDE.md). PlanDetail composes them; everything
  // else here is pure UI — DnD state + ghost, popover open-state,
  // the chat-log scroll ref, the per-plan prompt configs.

  // PCO-side state + slot operations.
  const planData = usePlanData(serviceTypeId, planId)
  const {
    plan,
    notes,
    items,
    loadError,
    theme,
    themeSource,
    notesText,
    notesSource,
    setTheme,
    setNotesText,
    resetTheme,
    resetNotes,
    performIntent,
    reorderSlotItem,
    refreshPlanState,
  } = planData

  // Songpicker-side candidate pool, depends on planData.
  const {
    candidates,
    messages,
    criteria,
    setCriteria,
    generating,
    generateError,
    rejectedPoolOpen,
    setRejectedPoolOpen,
    handleSuggest,
    setDecision,
    recheckCandidate,
    clearCandidates,
    isCandidateCommitted,
    ensureCandidate,
  } = useCandidatePool(planId, planData)

  // Wire slot-eviction notifications into the candidate pool. When a
  // song is cleared / displaced from the plan (via X click, DnD to
  // trash, DnD to suggestions, AI command — any path), it shows up
  // in the suggestions list as a pending candidate so the user can
  // drag it back without re-running Suggest. Matches the
  // setAppendSystemMessage wiring above it.
  useEffect(() => {
    planData.setOnSongEvicted(ensureCandidate)
    // Wiring is stable for the life of this component mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // UI-only state. Everything below this line is rendering / drag
  // concerns; nothing in this section talks to the model.

  const [openCommitMenuId, setOpenCommitMenuId] = useState<string | null>(null)
  useEffect(() => {
    if (!openCommitMenuId) return
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('.commit-menu')) return
      setOpenCommitMenuId(null)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [openCommitMenuId])

  const roleHook = usePromptConfig('role', planId)
  const structureHook = usePromptConfig('structure', planId)
  const [openPrompt, setOpenPrompt] = useState<OpenPrompt>(null)
  /** Single shared popover state for the lyrics viewer. Hoisted up
   *  here (rather than inside each LyricsTrigger) so clicking a chip
   *  on candidate A and then candidate B swaps content in one popover
   *  instead of toggling separate per-chip modals. */
  const [activeLyrics, setActiveLyrics] = useState<ActiveLyrics | null>(null)
  function togglePrompt(which: 'role' | 'structure') {
    setOpenPrompt((prev) => (prev === which ? null : which))
  }

  // Auto-scroll the chat log to the bottom whenever messages change
  // so streaming text + new turns stay in view.
  const chatLogRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = chatLogRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  // Drag-and-drop state. Two distinct drag modes:
  //   - 'candidate': dragging an AI suggestion onto an empty service-
  //     order slot. Drop assigns + commits in one step.
  //   - 'slot':      dragging a filled song slot onto the trash zone
  //     that appears at the top of the page mid-drag. Drop clears.
  // The drop-target highlights and the floating trash zone are gated on
  // this state.
  const [dragKind, setDragKind] = useState<'candidate' | 'slot' | null>(null)
  // Source identifier — candidate.id for 'candidate' drags, item.id for
  // 'slot' drags. We thread the source through React state rather than
  // dataTransfer.getData because some browsers (notably Firefox)
  // restrict reading custom mime types from dataTransfer in the drop
  // event, which would silently break the handler.
  const [dragSourceId, setDragSourceId] = useState<string | null>(null)
  // Hovered drop-target ids so we can highlight the specific slot or the
  // trash zone the user is over, instead of every valid target at once.
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null)
  // Whether the suggestions panel (right column) is the current drop
  // target during a slot drag. Dropping the slot on the suggestions
  // panel clears it and the executor's onSongEvicted returns the
  // displaced song to candidates.
  const [dragOverCandidates, setDragOverCandidates] = useState(false)

  // Floating-ghost we render ourselves at the cursor position during a
  // drag. The browser-default drag image was rendering blank, and
  // setDragImage on a styled clone also failed for this user — likely
  // a Chromium quirk on Retina-class displays. So we suppress the
  // browser's ghost entirely and paint our own labeled chip via a
  // dragover listener on the document.
  const [dragGhost, setDragGhost] = useState<{
    label: string
    sub: string | null
    x: number
    y: number
  } | null>(null)

  function endDrag() {
    setDragKind(null)
    setDragSourceId(null)
    setDragOverItemId(null)
    setDragOverCandidates(false)
    setDragGhost(null)
  }

  // While any drag is active, follow the cursor with our floating
  // ghost via the document-level dragover event (dragover fires
  // continuously and reports clientX/clientY).
  const dragGhostActive = dragGhost !== null
  useEffect(() => {
    if (!dragGhost) return
    function onMove(e: DragEvent) {
      // clientX/Y can briefly hit 0,0 right before drop on some
      // browsers; ignore those to avoid the ghost teleporting to the
      // corner.
      if (e.clientX === 0 && e.clientY === 0) return
      setDragGhost((prev) =>
        prev ? { ...prev, x: e.clientX, y: e.clientY } : null,
      )
    }
    document.addEventListener('dragover', onMove)
    return () => document.removeEventListener('dragover', onMove)
    // Only re-bind when the ghost transitions between active/inactive, not on
    // every position update. dragGhost is read inside the effect closure but
    // we deliberately don't depend on its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragGhostActive])

  // Suppress the browser's default drag image so it doesn't compete
  // with our floating ghost (and so users on Chromium/Retina don't see
  // it render as a blank rectangle either). A 1×1 transparent canvas
  // is the standard "invisible drag image" trick.
  function suppressNativeDragImage(e: React.DragEvent): void {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    try {
      e.dataTransfer.setDragImage(canvas, 0, 0)
    } catch {
      // Ignored — falls back to the browser default. We have the
      // floating ghost too, so the user still sees something.
    }
  }

  if (loadError) return <div className="error">Error loading plan: {loadError}</div>
  if (!plan || !notes || !items) return <div>Loading plan…</div>

  const subtitle = plan.title && plan.seriesTitle ? plan.seriesTitle : null

  return (
    <div className="plan-detail">
      {dragGhost && (
        <div
          className="drag-ghost"
          style={{
            left: dragGhost.x + 14,
            top: dragGhost.y + 14,
          }}
        >
          <div className="drag-ghost-title">{dragGhost.label}</div>
          {dragGhost.sub && (
            <div className="drag-ghost-sub">{dragGhost.sub}</div>
          )}
        </div>
      )}
      <div className="plan-header">
        <a
          className="back"
          href="#"
          onClick={(e) => {
            e.preventDefault()
            window.location.hash = ''
          }}
        >
          ← All plans
        </a>

        <h2>
          {plan.title || plan.seriesTitle || '(no title)'}
          <a
            className="pco-link iconbtn iconbtn-sm iconbtn-pco"
            href={`https://services.planningcenteronline.com/plans/${plan.id}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in Planning Center"
            aria-label="Open in Planning Center"
          >
            <img src="/planning-center-icon.png" alt="" className="iconbtn-img" />
          </a>
        </h2>
        <div className="meta">
          <span className="meta-text">
            {subtitle && <span>{subtitle} · </span>}
            {plan.sortDate &&
              new Date(plan.sortDate).toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            {(() => {
              const leaders =
                plan.teamMembers?.filter((m) => m.position === 'Worship Leader') ?? []
              return leaders.length > 0 ? (
                <> · led by {leaders.map((l) => l.name).join(', ')}</>
              ) : null
            })()}
          </span>
        </div>
      </div>

      <div className="plan-body">
        <div className="plan-left">
      {items.length > 0 && (
        <section className="service-order">
          <h3>Service order</h3>
          <ol>
            {items.map((it) => {
              // Filled = linked to a real song; isSong from shared helper so
              // the list-view badge and detail-view styling agree.
              const filled = it.songId != null
              const isSong = isSongSlot(it)
              const cls = `item type-${it.itemType}${
                isSong ? (filled ? ' song-filled' : ' song-empty-slot') : ''
              }`
              const displayTitle = it.title || it.songTitle || ''
              const showMeta =
                filled &&
                (it.keyName ||
                  it.description ||
                  it.notes.length > 0 ||
                  it.leaders.length > 0 ||
                  it.songAuthor ||
                  it.songCcli)
              const draggable = isSong && filled
              // Candidates can be dropped onto any song slot — empty
              // slots commit fresh, filled slots replace the existing
              // song (and return the displaced song to the candidate
              // pool as uncommitted).
              const isCommitTarget = dragKind === 'candidate' && isSong
              // Only song slots (filled OR empty) accept reorder drops —
              // dropping onto a Welcome / Announcements / Sermon item
              // would be confusing because those aren't the "spots"
              // worship leaders think of as positions to slot songs
              // into.
              const isReorderTarget =
                dragKind === 'slot' &&
                dragSourceId !== null &&
                dragSourceId !== it.id &&
                isSong
              const isDropTarget = isCommitTarget || isReorderTarget
              const isBeingDragged =
                dragKind === 'slot' && dragSourceId === it.id
              return (
                <li
                  key={it.id}
                  className={`${cls}${isDropTarget ? ' drag-target' : ''}${
                    isDropTarget && dragOverItemId === it.id ? ' drag-over' : ''
                  }${isReorderTarget ? ' drag-target-reorder' : ''}${
                    draggable ? ' is-draggable' : ''
                  }${isBeingDragged ? ' is-dragging' : ''}`}
                  draggable={draggable || undefined}
                  onDragStart={(e) => {
                    if (!draggable) return
                    e.dataTransfer.setData('text/plain', it.id)
                    e.dataTransfer.effectAllowed = 'move'
                    suppressNativeDragImage(e)
                    setDragKind('slot')
                    setDragSourceId(it.id)
                    setDragGhost({
                      label: it.songTitle ?? it.title ?? 'song',
                      sub: it.songAuthor ?? null,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }}
                  onDragEnd={() => {
                    if (draggable) endDrag()
                  }}
                  onDragOver={(e) => {
                    if (!isDropTarget) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragOverItemId !== it.id) setDragOverItemId(it.id)
                  }}
                  onDragLeave={() => {
                    if (isDropTarget && dragOverItemId === it.id) {
                      setDragOverItemId(null)
                    }
                  }}
                  onDrop={(e) => {
                    if (!isDropTarget) return
                    e.preventDefault()
                    if (dragKind === 'candidate' && dragSourceId) {
                      const candidate = candidates.find(
                        (c) => c.id === dragSourceId,
                      )
                      if (candidate) {
                        void performIntent(
                          compileDropCandidateOnSlot(candidate, it, items ?? []),
                        )
                      }
                    } else if (dragKind === 'slot' && dragSourceId) {
                      void reorderSlotItem(dragSourceId, it.id)
                    }
                    endDrag()
                  }}
                >
                  <span className="seq">{it.sequence}</span>
                  <div className="ibody">
                    {filled ? (
                      <div className="ititle-row">
                        <a
                          className="ititle ititle-link icon-text"
                          href={`https://services.planningcenteronline.com/songs/${it.songId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open song in Planning Center"
                          // Anchors are natively draggable (for URL
                          // drops); turn that off so the parent <li>
                          // gets the dragstart instead.
                          draggable={false}
                        >
                          {displayTitle || '(song)'}
                          <Icon name="external-link" size={12} />
                        </a>
                        {isSong && (
                          <button
                            type="button"
                            className="clear-slot-btn"
                            onClick={() =>
                              void performIntent(compileClearSlot(it, items ?? []))
                            }
                            title="Remove this song from the slot and reopen it for new suggestions"
                            aria-label="Remove song from slot"
                          >
                            <Icon name="x" size={14} />
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="ititle">{it.title || '(no title)'}</div>
                    )}
                    {isSong && !filled && (
                      <span className="song-empty">Drop a song here</span>
                    )}
                    {showMeta && (
                      <div className="item-meta">
                        {(it.leaders.length > 0 || (!filled && it.keyName)) && (
                        <div className="meta-chips">
                          {!filled && it.keyName && (
                            <span className="meta-chip">
                              Key <strong>{it.keyName}</strong>
                            </span>
                          )}
                          {it.leaders.map((leader, i) => (
                            <span key={i} className="meta-chip leader-chip">
                              <span className="leader-icon" aria-hidden>
                                ♪
                              </span>
                              {leader}
                            </span>
                          ))}
                        </div>
                        )}
                        {(it.songAuthor || it.songCcli) && (
                          <div className="meta-credits">
                            {it.songAuthor && (
                              <span>by <strong>{it.songAuthor}</strong></span>
                            )}
                            {it.songCcli && (
                              <span> · CCLI {it.songCcli}</span>
                            )}
                          </div>
                        )}
                        {it.description && (
                          <div className="meta-text">{it.description}</div>
                        )}
                        {it.notes.map((n, i) => (
                          <div key={i} className="meta-note">
                            {n.content}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {filled && (it.songId || displayTitle) && (
                    <div className="item-actions">
                      {it.songId && (
                        <ArrangementKeyEditor
                          serviceTypeId={serviceTypeId}
                          planId={planId}
                          item={it}
                          onSaved={refreshPlanState}
                        />
                      )}
                      {displayTitle && (
                        <div className="lookup-row">
                          <SongLookupLinks query={displayTitle} size="sm" />
                          <LyricsTrigger
                            variant="icon"
                            title={it.songTitle ?? displayTitle}
                            author={it.songAuthor}
                            onActivate={setActiveLyrics}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        </section>
      )}

      <section className="suggest-section">
        <div className="suggest-section-header">
          <h3>Suggest songs</h3>
          <div className="prompt-pills">
            <PromptPill
              type="role"
              label={PROMPT_COPY.role.label}
              source={roleHook.config?.effective.source ?? 'system'}
              isOpen={openPrompt === 'role'}
              onToggle={() => togglePrompt('role')}
            />
            <PromptPill
              type="structure"
              label={PROMPT_COPY.structure.label}
              source={structureHook.config?.effective.source ?? 'system'}
              isOpen={openPrompt === 'structure'}
              onToggle={() => togglePrompt('structure')}
            />
          </div>
        </div>
        {openPrompt === 'role' && (
          <PromptBody
            label={PROMPT_COPY.role.label}
            help={PROMPT_COPY.role.help}
            hook={roleHook}
          />
        )}
        {openPrompt === 'structure' && (
          <PromptBody
            label={PROMPT_COPY.structure.label}
            help={PROMPT_COPY.structure.help}
            hook={structureHook}
          />
        )}
        <div className="suggest-form">
        <label>
          <span className="theme-label">
            <span>
              Theme <span className="source-hint">· from Planning Center title</span>
            </span>
            {theme.trim() !== themeSource.trim() && (
              <>
                <span
                  className="edited-flag"
                  title={`Differs from Planning Center: "${themeSource || '(empty)'}"`}
                >
                  edited
                </span>
                <button
                  type="button"
                  className="reset-btn"
                  onClick={resetTheme}
                  title="Reset to the Planning Center value (clears your saved override)"
                >
                  ↺ reset
                </button>
              </>
            )}
          </span>
          <input
            type="text"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder="What is the service about?"
          />
        </label>
        <label>
          <span className="theme-label">
            <span>
              Context{' '}
              <span className="source-hint">· from Planning Center service notes</span>
            </span>
            {notesText.trim() !== notesSource.trim() && (
              <>
                <span
                  className="edited-flag"
                  title={
                    notesSource
                      ? `Differs from Planning Center notes:\n${notesSource}`
                      : 'No notes set in Planning Center'
                  }
                >
                  edited
                </span>
                <button
                  type="button"
                  className="reset-btn"
                  onClick={resetNotes}
                  title="Reset to the Planning Center value (clears your saved override)"
                >
                  ↺ reset
                </button>
              </>
            )}
          </span>
          <textarea
            rows={Math.min(8, Math.max(3, notesText.split('\n').length + 1))}
            value={notesText}
            onChange={(e) => setNotesText(e.target.value)}
            placeholder="Sermon theme, scripture, anything else worth flagging to the AI."
          />
        </label>
        {messages.length > 0 && (
          <div className="chat-log" ref={chatLogRef}>
            {messages.map((m, idx) => {
              if (m.role === 'system') {
                return (
                  <div key={m.id} className="chat-msg chat-msg-system">
                    {m.content}
                  </div>
                )
              }
              // The in-flight assistant message gets a typing cursor
              // so the user can see it's still being generated even
              // when the model pauses between tokens. We detect it as
              // the last message in the log while generating is true
              // and the role is assistant.
              const isStreaming =
                generating &&
                m.role === 'assistant' &&
                idx === messages.length - 1
              return (
                <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
                  <span className="chat-role">
                    {m.role === 'user' ? (
                      'You'
                    ) : (
                      <>
                        <span className="sparkle" aria-hidden>✨</span> AI
                      </>
                    )}
                  </span>
                  <div className="chat-content">
                    {m.content}
                    {isStreaming && <span className="streaming-cursor" aria-hidden>▍</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <label>
          <span>
            {messages.length === 0
              ? 'Criteria (mood, tempo, era, must-include, avoid)'
              : 'Chat with the AI'}
          </span>
          <textarea
            rows={messages.length === 0 ? 4 : 2}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter inserts a newline. Matches the
              // chat-style convention; multi-line refinements still
              // possible when you really need them.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (!generating && theme.trim()) void handleSuggest()
              }
            }}
            placeholder={
              messages.length === 0
                ? "e.g. upbeat opener, slower communion song, include 'Cornerstone'"
                : "e.g. drop the upbeat ones, give me two slower options for the closer, swap candidate X for something newer"
            }
          />
        </label>
        <div className="row">
          <button
            className="ai-button"
            onClick={() => void handleSuggest()}
            disabled={generating || !theme.trim()}
          >
            <span className="sparkle" aria-hidden>✨</span>
            {generating
              ? 'Thinking…'
              : messages.length === 0
                ? 'Suggest songs'
                : 'Send'}
          </button>
          {(candidates.length > 0 || messages.length > 0) && (
            <button
              className="ghost"
              onClick={clearCandidates}
              disabled={generating}
              title="Wipe all AI suggestions and the chat history for this plan. Committed songs in Planning Center are not affected — the AI will start the next turn fresh, using only what's in PCO."
            >
              Clear conversation
            </button>
          )}
        </div>
        {generateError && <div className="error">Error: {generateError}</div>}
        </div>
      </section>

      {(() => {
        const rejected = candidates.filter((c) => c.decision === 'reject')
        if (rejected.length === 0) return null
        return (
          <details
            className="rejected-pool"
            open={rejectedPoolOpen}
            onToggle={(e) => setRejectedPoolOpen(e.currentTarget.open)}
          >
            <summary>
              <span className="chevron" aria-hidden>▸</span>
              <span>{rejected.length} rejected</span>
            </summary>
            <ul className="rejected-list">
              {rejected.map((c) => (
                <li key={c.id} className="rejected-card">
                  <div className="rejected-title">
                    {c.suggestion.title}
                    {c.suggestion.author && (
                      <span className="author"> — {c.suggestion.author}</span>
                    )}
                  </div>
                  {c.suggestion.chorusSnippet && (
                    <div
                      className="rejected-snippet"
                      title={snippetTooltip(c.suggestion.snippetSource)}
                    >
                      &ldquo;{formatSnippet(c.suggestion.chorusSnippet)}&rdquo;
                      <LyricsTrigger
                        variant="chip"
                        title={c.song?.title ?? c.suggestion.title}
                        author={c.song?.author ?? c.suggestion.author ?? null}
                        onActivate={setActiveLyrics}
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    className="decision-btn"
                    onClick={() => setDecision(c.id, 'reject')}
                    title="Bring this candidate back to the active pool"
                  >
                    ↶ Unreject
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )
      })()}

        </div>

        <div
          className={`plan-right${
            dragKind === 'slot' ? ' drag-target-candidates' : ''
          }${dragOverCandidates ? ' drag-over' : ''}`}
          onDragOver={(e) => {
            if (dragKind !== 'slot' || !dragSourceId) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (!dragOverCandidates) setDragOverCandidates(true)
          }}
          onDragLeave={(e) => {
            // dragleave fires for every child crossed; only flip off
            // when the cursor actually exits the panel.
            const related = e.relatedTarget as Node | null
            if (related && e.currentTarget.contains(related)) return
            if (dragOverCandidates) setDragOverCandidates(false)
          }}
          onDrop={(e) => {
            if (dragKind !== 'slot' || !dragSourceId) return
            e.preventDefault()
            const slot = (items ?? []).find((it) => it.id === dragSourceId)
            if (slot) {
              void performIntent(compileClearSlot(slot, items ?? []))
            }
            endDrag()
          }}
        >
      {dragKind === 'slot' && (
        <div className="candidates-drop-hint" aria-hidden>
          <span className="candidates-drop-icon">↩</span>
          <span>Drop to return this song to candidates</span>
        </div>
      )}
      {candidates.length === 0 && (
        <EmptyState
          icon="sparkle"
          title="No suggestions yet"
          body={
            <>
              Tap <span className="empty-state-emph">Suggest songs</span> to
              get a fresh round from the AI.
            </>
          }
        />
      )}
      {candidates.length > 0 && (() => {
        // Active = not-rejected. Rejected ones get tucked into the
        // collapsed disclosure below to reduce clutter. Committed
        // candidates stay in the active list too, just with the
        // committed-badge instead of the slot picker.
        const active = candidates.filter((c) => c.decision !== 'reject')
        const emptySongSlots = (items ?? []).filter(
          (it) => isSongSlot(it) && !it.songId,
        )

        if (active.length === 0) return null
        return (
        <section className="candidates">
          <h3 className="ai-heading">
            <span className="sparkle" aria-hidden>✨</span>
            <span className="gradient-text">AI candidates</span>
            <span className="candidates-summary">({active.length})</span>
          </h3>
          <ul>
            {active.map((c, i) => {
              const matched = c.matchStatus === 'matched' && c.song
              const isCommitted = isCandidateCommitted(c)
              const candidateDraggable = !!matched && !isCommitted
              const candidateBeingDragged =
                dragKind === 'candidate' && dragSourceId === c.id
              // Stagger entrance — CSS animation reads this delay so
              // newly-arrived cards cascade in instead of all popping
              // at once. Cap at 12 so a big batch doesn't drag on.
              const enterDelay = `${Math.min(i, 12) * 50}ms`
              return (
                <li
                  key={c.id}
                  className={`candidate match-${c.matchStatus} decision-${c.decision}${
                    candidateDraggable ? ' is-draggable' : ''
                  }${candidateBeingDragged ? ' is-dragging' : ''}`}
                  style={{ animationDelay: enterDelay }}
                  draggable={candidateDraggable || undefined}
                  onDragStart={(e) => {
                    if (!candidateDraggable) return
                    // text/plain keeps Firefox happy; the real payload
                    // lives in dragKind + dragSourceId.
                    e.dataTransfer.setData('text/plain', c.id)
                    e.dataTransfer.effectAllowed = 'move'
                    suppressNativeDragImage(e)
                    setDragKind('candidate')
                    setDragSourceId(c.id)
                    setDragGhost({
                      label: c.suggestion.title,
                      sub: c.suggestion.author ?? null,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }}
                  onDragEnd={endDrag}
                >
                  <div className="ctitle">
                    {matched ? (
                      <a
                        className="ctitle-link icon-text"
                        href={`https://services.planningcenteronline.com/songs/${c.song!.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open in Planning Center"
                        draggable={false}
                      >
                        {c.suggestion.title}
                        <Icon name="external-link" size={12} />
                      </a>
                    ) : (
                      c.suggestion.title
                    )}
                    {c.suggestion.author && (
                      <span className="author"> — {c.suggestion.author}</span>
                    )}
                  </div>
                  <div className="cstatus">
                    {c.suggestion.slots?.map((s, si) => (
                      <span key={`slot-${si}`} className="slot-tag">
                        {s}
                      </span>
                    ))}
                    {c.matchStatus === 'checking' && (
                      <span className="chip chip-checking">
                        checking library…
                      </span>
                    )}
                    {matched && (
                      <>
                        <span className="chip chip-matched">
                          <Icon name="check" size={12} />
                          in library
                        </span>
                        {c.enrichmentPending ? (
                          // PlanItem doesn't carry lastScheduledAt — we
                          // fetch it via getSong on eviction-mint.
                          // Suppress the "never played" lie while in
                          // flight. On fetch failure the flag stays
                          // true forever so the chip stays hidden —
                          // truthful beats best-effort.
                          <span className="chip chip-checking">
                            loading history…
                          </span>
                        ) : c.song!.lastScheduledAt ? (
                          (() => {
                            // PCO's last_scheduled_at includes future
                            // plans — a song queued on next Sunday's
                            // plan comes back as a future timestamp.
                            // Branch on past vs future inside the
                            // helper so the chip never says "last
                            // played today" for an upcoming schedule.
                            const d = lastScheduledDisplay(
                              c.song!.lastScheduledAt,
                            )
                            if (!d) return null
                            return (
                              <span
                                className={`chip chip-time${d.recent ? ' chip-recent' : ''}`}
                                title={d.tooltip}
                              >
                                {d.label}
                              </span>
                            )
                          })()
                        ) : (
                          // null lastScheduledAt after enrichment +
                          // retry has settled. Could mean: genuinely
                          // never scheduled, scheduled only in other
                          // service types (PCO scopes this field),
                          // or PCO's index never caught up. "no
                          // scheduling found" is honest in all three
                          // cases; "never played" was the lie.
                          <span
                            className="chip chip-time chip-never"
                            title="Planning Center didn't return a scheduling date for this song. It may genuinely not have been scheduled, or the schedule index hasn't caught up yet."
                          >
                            no scheduling found
                          </span>
                        )}
                        {c.song!.ccliNumber && (
                          <span
                            className="chip chip-ccli"
                            title="CCLI number"
                          >
                            CCLI {c.song!.ccliNumber}
                          </span>
                        )}
                      </>
                    )}
                    {c.matchStatus === 'unmatched' && (
                      <a
                        className="chip chip-unmatched chip-link"
                        href="https://services.planningcenteronline.com/songs/"
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open your Planning Center song library in a new tab to add this song"
                        draggable={false}
                      >
                        <Icon name="alert-triangle" size={12} />
                        not in library, add
                        <Icon name="external-link" size={11} />
                      </a>
                    )}
                    {c.matchStatus === 'error' && (
                      <span
                        className="chip chip-error"
                        title={c.error}
                      >
                        lookup failed
                      </span>
                    )}
                  </div>
                  {c.enrichmentPending && !c.suggestion.chorusSnippet ? (
                    <div className="snippet-shimmer" />
                  ) : c.suggestion.chorusSnippet ? (
                    <div
                      className="chorus-snippet"
                      title={snippetTooltip(c.suggestion.snippetSource)}
                    >
                      <span className="snippet-quote" aria-hidden>"</span>
                      {formatSnippet(c.suggestion.chorusSnippet)}
                      <span className="snippet-quote" aria-hidden>"</span>
                      <LyricsTrigger
                        variant="chip"
                        title={c.song?.title ?? c.suggestion.title}
                        author={c.song?.author ?? c.suggestion.author ?? null}
                        onActivate={setActiveLyrics}
                      />
                    </div>
                  ) : c.suggestion.snippetSource ? (
                    <div className="snippet-unavailable">
                      Lyrics not found
                      <LyricsTrigger
                        variant="chip"
                        title={c.song?.title ?? c.suggestion.title}
                        author={c.song?.author ?? c.suggestion.author ?? null}
                        onActivate={setActiveLyrics}
                      />
                    </div>
                  ) : null}
                  <div className="decision-row">
                    {/* Outbound listen/lookup buttons — square icon-only,
                        brand-colored on hover. Provider list lives in
                        SongLookupLinks so this row stays in sync with
                        the service-order filled-slot row. */}
                    <div className="listen-actions">
                      <SongLookupLinks query={c.suggestion.title} />
                    </div>

                    <div className="decision-actions">
                      <button
                        type="button"
                        className={`decision-btn decision-reject icon-text${c.decision === 'reject' ? ' on' : ''}`}
                        onClick={() => setDecision(c.id, 'reject')}
                        disabled={isCommitted}
                        title={
                          c.decision === 'reject'
                            ? 'Click again to undo'
                            : 'Reject this song'
                        }
                      >
                        <Icon name="x" size={13} />
                        Reject
                      </button>

                      {(c.matchStatus === 'unmatched' ||
                        c.matchStatus === 'error' ||
                        c.matchStatus === 'checking') && (
                        // Only meaningful for not-yet-matched rows. The
                        // user added the song in Planning Center after
                        // we first looked; this re-runs the library
                        // search so a fresh match unlocks Commit.
                        <button
                          type="button"
                          className="decision-btn decision-recheck icon-text"
                          onClick={() => recheckCandidate(c.id)}
                          disabled={c.matchStatus === 'checking'}
                          title="Already added it in Planning Center? Re-check the library."
                        >
                          <Icon name="refresh" size={13} />
                          {c.matchStatus === 'checking'
                            ? 'Checking…'
                            : 'Re-check'}
                        </button>
                      )}

                      {matched && isCommitted && (
                        // Service order on the left is the source of
                        // truth for WHICH slot. Showing a slot label
                        // here was nonsensical anyway — PCO overwrites
                        // the slot's title with the song name on commit.
                        <span className="committed-badge icon-text">
                          <Icon name="check" size={13} />
                          Committed
                        </span>
                      )}

                      {matched && !isCommitted && (() => {
                        // Replaces the old <select> with a button +
                        // popover. The button is the primary "action"
                        // affordance on each card and gets accent
                        // styling; the popover lists the same options
                        // the select used to.
                        const avail = emptySongSlots
                        const isOpen = openCommitMenuId === c.id
                        const disabled = avail.length === 0
                        return (
                          <div
                            className={`commit-menu${isOpen ? ' open' : ''}`}
                          >
                            <button
                              type="button"
                              className="commit-btn icon-text"
                              disabled={disabled}
                              onClick={() =>
                                setOpenCommitMenuId(isOpen ? null : c.id)
                              }
                              title={
                                disabled
                                  ? 'No empty song slots available'
                                  : 'Commit to slot'
                              }
                              aria-haspopup="menu"
                              aria-expanded={isOpen}
                            >
                              {disabled ? 'No open slots' : 'Commit to slot'}
                              {!disabled && (
                                <Icon name="chevron-down" size={13} />
                              )}
                            </button>
                            {isOpen && !disabled && (
                              <div
                                className="commit-menu-pop"
                                role="menu"
                              >
                                {avail.map((s) => (
                                  <button
                                    key={s.id}
                                    type="button"
                                    role="menuitem"
                                    className="commit-menu-item"
                                    onClick={() => {
                                      setOpenCommitMenuId(null)
                                      void performIntent(
                                        compileCommitToSlot(c, s, items ?? []),
                                      )
                                    }}
                                  >
                                    {s.title}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          {/* end candidates list */}
        </section>
        )
      })()}
        </div>
      </div>
      {activeLyrics && (
        <LyricsPopover
          song={activeLyrics}
          onClose={() => setActiveLyrics(null)}
        />
      )}
    </div>
  )
}

