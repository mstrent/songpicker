import type { Plan, ResolvedCommit, ResolvedEntry } from './resolver'

// Pure message synthesis for slot-state changes. Both AI-driven and
// user-driven (UI) flows emit the same chat-log entries through
// here, so the chat reads consistently and a swap is always
// rendered as one "swapped" line rather than two "committed" lines.

export type MessageSource = 'user' | 'ai'

const PREFIX: Record<MessageSource, { commit: string; move: string; clear: string; swap: string }> = {
  user: { commit: '↗', move: '↕', clear: '↶', swap: '↔' },
  ai: { commit: '🤖 AI committed', move: '🤖 AI moved', clear: '🤖 AI cleared', swap: '🤖 AI swapped' },
}

/** Format a single resolved-commit entry as a chat-log line. */
function commitMessage(r: ResolvedCommit, source: MessageSource): string {
  const replaceSuffix = r.evicted
    ? ` (replacing "${r.evicted.suggestion.title}")`
    : r.slotItem.songId && r.slotItem.songTitle
      ? ` (replacing "${r.slotItem.songTitle}")`
      : ''
  if (source === 'ai') {
    if (r.isMove) {
      return `🤖 AI moved "${r.songTitle}" from song slot ${r.fromSlotIndex ?? '?'} to song slot ${r.slotIndex}${replaceSuffix}`
    }
    return `🤖 AI committed "${r.songTitle}" to song slot ${r.slotIndex}${replaceSuffix}`
  }
  // User flow uses the slot's current title as the human-friendly
  // label (e.g., "Closing song") rather than the position-based
  // index — that's what the user dragged onto, after all.
  const slotLabel = r.slotItem.title?.trim() || `Song ${r.slotIndex}`
  if (r.isMove) {
    return `${PREFIX.user.move} Moved "${r.songTitle}" → ${slotLabel}${replaceSuffix}`
  }
  return `${PREFIX.user.commit} Committed "${r.songTitle}" → ${slotLabel}${replaceSuffix}`
}

/** Format a single resolved-clear entry. */
function clearMessage(r: Extract<ResolvedEntry, { kind: 'clear' }>, source: MessageSource): string {
  const songTitle = r.occupant?.suggestion.title ?? r.slotItem.songTitle ?? 'song'
  if (source === 'ai') {
    return `🤖 AI cleared "${songTitle}" from song slot ${r.slotIndex}`
  }
  const slotLabel = r.slotItem.title?.trim() || `Song ${r.slotIndex}`
  return `${PREFIX.user.clear} Cleared "${songTitle}" from ${slotLabel}`
}

/** Format a swap-pair as a single combined chat line. */
function swapMessage(a: ResolvedCommit, b: ResolvedCommit, source: MessageSource): string {
  if (source === 'ai') {
    return `🤖 AI swapped "${a.songTitle}" and "${b.songTitle}"`
  }
  return `${PREFIX.user.swap} Swapped "${a.songTitle}" with "${b.songTitle}"`
}

/** Synthesize the chat-log lines for a Plan. One line per resolved
 *  entry, except a detected swap-pair collapses into one combined
 *  "swapped" line rather than two separate commits. Returns lines in
 *  resolved-entry order (with the swap-pair line emitted at the
 *  position of the first half). */
export function synthesizeMessages(plan: Plan, source: MessageSource): string[] {
  const out: string[] = []
  const emitted = new Set<number>()
  for (let i = 0; i < plan.resolved.length; i++) {
    if (emitted.has(i)) continue
    const r = plan.resolved[i]
    if (r.kind === 'clear') {
      out.push(clearMessage(r, source))
      emitted.add(i)
      continue
    }
    const partner = plan.swapPairs.get(i)
    if (partner !== undefined && !emitted.has(partner)) {
      const other = plan.resolved[partner]
      if (other.kind === 'commit') {
        out.push(swapMessage(r, other, source))
        emitted.add(i)
        emitted.add(partner)
        continue
      }
    }
    out.push(commitMessage(r, source))
    emitted.add(i)
  }
  return out
}
