import type { Plan, ResolvedCommit, ResolvedEntry } from './resolver'

// Pure message synthesis for slot-state changes. Both AI-driven and
// user-driven (UI) flows emit the same chat-log entries through
// here, so the chat reads consistently and a swap is always
// rendered as one "swapped" line rather than two "committed" lines.

export type MessageSource = 'user' | 'ai'

const PREFIX: Record<
  MessageSource,
  { commit: string; move: string; clear: string; swap: string }
> = {
  user: { commit: '↗', move: '↕', clear: '↶', swap: '↔' },
  ai: {
    commit: '🤖 AI committed',
    move: '🤖 AI moved',
    clear: '🤖 AI cleared',
    swap: '🤖 AI swapped',
  },
}

function commitMessage(r: ResolvedCommit, source: MessageSource): string {
  const replaceSuffix = r.evictedSongTitle
    ? ` (replacing "${r.evictedSongTitle}")`
    : ''
  if (source === 'ai') {
    if (r.isMove) {
      return `🤖 AI moved "${r.songTitle}" from song slot ${r.fromSlotIndex ?? '?'} to song slot ${r.slotIndex}${replaceSuffix}`
    }
    return `🤖 AI committed "${r.songTitle}" to song slot ${r.slotIndex}${replaceSuffix}`
  }
  const slotLabel = r.slotItem.title?.trim() || `Song ${r.slotIndex}`
  if (r.isMove) {
    return `${PREFIX.user.move} Moved "${r.songTitle}" → ${slotLabel}${replaceSuffix}`
  }
  return `${PREFIX.user.commit} Committed "${r.songTitle}" → ${slotLabel}${replaceSuffix}`
}

function clearMessage(
  r: Extract<ResolvedEntry, { kind: 'clear' }>,
  source: MessageSource,
): string {
  const songTitle = r.evictedSongTitle ?? r.slotItem.songTitle ?? 'song'
  if (source === 'ai') {
    return `🤖 AI cleared "${songTitle}" from song slot ${r.slotIndex}`
  }
  const slotLabel = r.slotItem.title?.trim() || `Song ${r.slotIndex}`
  return `${PREFIX.user.clear} Cleared "${songTitle}" from ${slotLabel}`
}

function swapMessage(
  a: ResolvedCommit,
  b: ResolvedCommit,
  source: MessageSource,
): string {
  if (source === 'ai') {
    return `🤖 AI swapped "${a.songTitle}" and "${b.songTitle}"`
  }
  return `${PREFIX.user.swap} Swapped "${a.songTitle}" with "${b.songTitle}"`
}

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
