import type { AiCandidate, SuggestRequest } from './types'

/** Two-part user message: the `stable` half (theme + plan notes +
 *  structure + service order) tends not to change between turns of
 *  the same session, so it gets a cache_control breakpoint in the
 *  Anthropic request. The `volatile` half (candidates + alreadyInPlan
 *  + the user's latest typed input) is fresh every turn and lives
 *  past the cache boundary. */
export interface BuiltUserMessage {
  stable: string
  volatile: string
}

/** Appended to the volatile half when the SPA fires a turn
 *  automatically (no typed user input). Overrides the system prompt's
 *  default "be conversational" guidance so an auto-refresh doesn't
 *  interrupt the user with a paragraph after every reject. Exported so
 *  the admin endpoint can surface it read-only alongside the tool
 *  descriptions. */
export const AUTO_REFRESH_NUDGE =
  "[auto-refresh] This turn was fired automatically after the user adjusted state without asking anything. Be terse: at most ONE short sentence in your text reply, or none at all — let the action markers speak. Don't summarise what you did. Only call propose_songs if a still-unfilled role's options have actually dropped below 2; otherwise prefer doing nothing."

/** Shared formatter for the "what plan are we working on?" lines —
 *  Theme / Plan notes / Service structure / Current service order.
 *  Used by both the main suggester (as the stable, prompt-cached
 *  prefix) and the single-shot classifier. Single source of truth so
 *  the two flows can't drift in label or ordering. Output is
 *  byte-identical to the prior inline suggester format to preserve
 *  the 1h cache_control prefix on already-warm sessions. */
export function formatPlanContextLines(req: {
  theme?: string
  planNotes?: string
  structurePrompt?: string
  serviceOrder?: string
}): string[] {
  const lines: string[] = []
  // Theme is emitted unmodified so the cached prefix in the suggester
  // flow stays byte-identical with the prior code path. Callers should
  // pass an already-trimmed value when they have one.
  if (req.theme && req.theme.trim()) {
    lines.push(`Theme: ${req.theme}`)
  }
  if (req.planNotes && req.planNotes.trim()) {
    lines.push(`Plan notes:\n${req.planNotes.trim()}`)
  }
  if (req.structurePrompt && req.structurePrompt.trim()) {
    lines.push(`Service structure: ${req.structurePrompt.trim()}`)
  }
  if (req.serviceOrder && req.serviceOrder.trim()) {
    lines.push(`Current service order:\n${req.serviceOrder.trim()}`)
  }
  return lines
}

// Single source of truth for the user-side text the AI sees on the
// current turn. The chat history (prior user/assistant turns) carries
// the user's typed inputs and the AI's prose replies; this function
// only assembles the LATEST turn, including a fresh snapshot of plan
// state so the AI always reasons against current reality.
export function buildUserMessage(req: SuggestRequest): BuiltUserMessage {
  const stableParts = formatPlanContextLines(req)
  // Rotation context rides in the stable half: it derives from past
  // plans, so it doesn't move when the user commits to this one.
  // Deliberately not part of formatPlanContextLines — the slot
  // classifier shares that formatter and has no use for it.
  if (req.recentlySung && req.recentlySung.trim()) {
    stableParts.push(req.recentlySung.trim())
  }

  const volatileParts: string[] = []
  if (req.candidates && req.candidates.length > 0) {
    volatileParts.push(`Current candidates:\n${renderCandidates(req.candidates)}`)
  }
  if (req.alreadyInPlan && req.alreadyInPlan.length > 0) {
    volatileParts.push(
      `Already in plan (don't re-suggest): ${req.alreadyInPlan.join(', ')}`,
    )
  }
  volatileParts.push(`User request: ${req.userMessage || '(none)'}`)
  if (req.autoRefresh) {
    volatileParts.push(AUTO_REFRESH_NUDGE)
  }

  return {
    stable: stableParts.join('\n'),
    volatile: volatileParts.join('\n'),
  }
}

// One line per candidate. Stratified by decision to keep the volatile
// block small in long sessions:
//   committed → id, title, author, "— committed→slot N" (service order
//     already shows everything else about this song)
//   rejected  → id, title, author, "— rejected"
//   pending   → full content (the AI is actively reasoning here)
// `author` always goes through regardless of decision — worship song
// titles are often ambiguous ("Way Maker", "How Great Is Our God") and
// the AI needs the disambiguator. Same for the user reading the chat.
function renderCandidates(candidates: AiCandidate[]): string {
  return candidates.map(renderCandidate).join('\n')
}

function renderCandidate(c: AiCandidate): string {
  const parts: string[] = [`  ${c.id} — "${c.title}"`]
  if (c.author) parts.push(`(${c.author})`)

  if (c.committed) {
    if (c.assignedSlot) {
      parts.push(`— committed → slot ${c.assignedSlot.index} of ${c.assignedSlot.total}`)
    } else {
      parts.push('— committed')
    }
    return parts.join(' ')
  }

  if (c.decision === 'reject') {
    parts.push('— rejected')
    return parts.join(' ')
  }

  parts.push('— pending')
  if (c.inLibrary === false) {
    parts.push(`— NOT IN LIBRARY (can't be committed via set_slot_contents)`)
  }
  if (c.assignedSlot) {
    parts.push(
      `— earmarked for song slot ${c.assignedSlot.index} of ${c.assignedSlot.total}`,
    )
  }
  if (c.slots && c.slots.length > 0) {
    parts.push(`— tagged: ${c.slots.join(', ')}`)
  }
  return parts.join(' ')
}

/** Build a representative per-turn user message for the admin page.
 *  Uses placeholder dynamic values + one candidate of each decision
 *  type so admins can see the exact format the model receives —
 *  including the section labels, the candidate-block decorations,
 *  and the auto-refresh nudge. Pure function with no I/O; safe to
 *  call from a hot path if ever needed. */
export function buildSampleUserMessage(): BuiltUserMessage {
  return buildUserMessage({
    theme: '<plan theme>',
    userMessage: '<user input>',
    structurePrompt: '<resolved structure prompt — per-plan → user → admin → hardcoded>',
    systemPrompt: '<unused for this preview>',
    serviceOrder:
      '1. Welcome\n2. [song slot 1 of 2] — picked: Build My Life\n3. Announcements\n4. [song slot 2 of 2] — (empty, needs a pick)',
    planNotes: '<plan notes from Planning Center + per-plan overrides>',
    candidates: [
      {
        id: 'c_sample_pending',
        title: 'Sample Pending Song',
        author: 'Sample Author',
        slots: ['opener', 'mid-service'],
        decision: 'pending',
        assignedSlot: { index: 2, total: 2 },
        committed: false,
        inLibrary: true,
      },
      {
        id: 'c_sample_unmatched',
        title: 'Sample Unmatched Song',
        author: 'Sample Author',
        decision: 'pending',
        committed: false,
        inLibrary: false,
      },
      {
        id: 'c_sample_committed',
        title: 'Sample Committed Song',
        author: 'Sample Author',
        decision: 'pending',
        assignedSlot: { index: 1, total: 2 },
        committed: true,
        inLibrary: true,
      },
      {
        id: 'c_sample_rejected',
        title: 'Sample Rejected Song',
        author: 'Sample Author',
        decision: 'reject',
        committed: false,
        inLibrary: true,
      },
    ],
    alreadyInPlan: ['Another Song Already In The Plan'],
    history: [],
    autoRefresh: false,
  })
}
