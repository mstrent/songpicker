import type { CommonReason } from './api'

// Cap on how many AI-distilled chips surface to end users at once.
// Seed + manual chips are always shown (admin-curated); AI chips
// compete for these slots ranked by usage. Keeps the user picker
// clutter-bounded while the admin sees the full pool, including
// "proto" AI chips that haven't earned a slot yet.
export const MAX_USER_AI_CHIPS = 3

function topAiByUse(all: CommonReason[]): CommonReason[] {
  return all
    .filter((c) => c.source === 'ai')
    .sort((a, b) => b.useCount - a.useCount || b.addedAt - a.addedAt)
    .slice(0, MAX_USER_AI_CHIPS)
}

// Chips that end users see on the rejection-rationale picker.
// Preserves the natural order of seed/manual chips and appends the
// top AI chips after them.
export function pickerVisibleChips(all: CommonReason[]): CommonReason[] {
  const curated = all.filter((c) => c.source !== 'ai')
  return [...curated, ...topAiByUse(all)]
}

// Text values of AI chips that ARE in the user-facing top — used by
// the admin UI to dim the rest as "proto" (still in the pool, not yet
// shown to users).
export function activeAiChipTexts(all: CommonReason[]): Set<string> {
  return new Set(topAiByUse(all).map((c) => c.text))
}
