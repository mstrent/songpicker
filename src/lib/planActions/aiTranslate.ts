import type { Assignment } from './resolver'

// Translation helper for the AI's set_slot_contents tool. The AI
// emits {slotIndex, candidateId | null} (its tool surface didn't
// move during Phase 6 — see CLAUDE.md). The unified resolver +
// executor speak {slotIndex, song: {id, title} | null}. This pure
// helper bridges the two: looks each candidate up by id, pulls the
// matched library song, surfaces warnings for the cases the AI
// can hit (unknown candidate, candidate without a matched song).
//
// Called from useCandidatePool's applyAction; lives here as a pure
// function so it's directly unit-testable without a hook harness.

/** Minimal candidate shape the translator needs. CandidateMatch (in
 *  useCandidatePool) satisfies this structurally. */
export interface TranslatableCandidate {
  id: string
  suggestion: { title: string }
  song?: { id?: string; title?: string | null } | null | undefined
}

/** AI's raw assignment shape — what the tool emits. */
export interface AiAssignment {
  slotIndex: number
  candidateId: string | null
}

export interface TranslateResult {
  /** Resolver-shaped assignments ready to feed to performIntent. */
  assignments: Assignment[]
  /** ⚠ messages the caller should append to the chat log for each
   *  skipped AI assignment. */
  warnings: string[]
}

export function translateAiAssignments(
  aiAssignments: readonly AiAssignment[],
  candidates: readonly TranslatableCandidate[],
): TranslateResult {
  const candById = new Map(candidates.map((c) => [c.id, c]))
  const assignments: Assignment[] = []
  const warnings: string[] = []
  for (const a of aiAssignments) {
    if (a.candidateId == null) {
      assignments.push({ slotIndex: a.slotIndex, song: null })
      continue
    }
    const c = candById.get(a.candidateId)
    if (!c) {
      warnings.push(
        `AI referenced an unknown candidate (${a.candidateId}) — skipped`,
      )
      continue
    }
    if (!c.song?.id) {
      warnings.push(
        `AI tried to commit "${c.suggestion.title}" but it isn't matched to a song in your Planning Center library — skipped`,
      )
      continue
    }
    assignments.push({
      slotIndex: a.slotIndex,
      song: { id: c.song.id, title: c.suggestion.title },
    })
  }
  return { assignments, warnings }
}
