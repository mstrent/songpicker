import Anthropic from '@anthropic-ai/sdk'

// Ancillary Claude calls used by the rejection-reason pipeline. These
// are all small classification / short-label tasks, not the heavy
// generative work the main suggestion engine does — so they run on
// Haiku, which is several-times cheaper and substantially faster.
// The main `suggestSongs` flow still uses Sonnet 4.6.

const MODEL = 'claude-haiku-4-5-20251001'

const MATCH_SYSTEM_PROMPT = `You match a freeform "why I rejected this worship song" reason to an existing one-tap chip when the user's intent clearly aligns with one of the chips. The user typed the freeform reason themselves; the chips are the short canonical labels we'd want them to have tapped instead.

Rules:
- Return EXACTLY one of the chip strings (verbatim, including capitalization), or null.
- Match on intent / meaning, not literal words. "Way too slow for an opener" matches "Too slow".
- If there's no clear match — or two chips fit equally well — return null. False matches are worse than no match.

Reply ONLY with JSON in this exact shape:
{"match":"Too slow"}
or
{"match":null}`

const DISTILL_SINGLE_SYSTEM_PROMPT = `You turn one freeform "why I rejected this worship song" reason into a short canonical chip label suitable for a one-tap button. The user just typed a reason for rejecting an AI-suggested song; your job is to compress their wording into a tidy reusable chip the next user can tap.

Rules:
- 2 to 4 words MAX. Button labels, not sentences.
- Noun phrase or short adjective phrase ("Too slow", "Theme mismatch", "Recently played").
- No trailing punctuation, no quotes.
- Self-contained — readable without context.
- The chip must NOT semantically duplicate any item in the existing chip list (those have already been ruled out by upstream matching, so the new chip should be a genuinely new category).
- If the user's text is too garbled, single-use, or doesn't represent a generalizable reason, return null. Don't force a chip out of bad input.

Reply ONLY with JSON in this exact shape:
{"label":"Too slow"}
or
{"label":null}`

interface MatchInput {
  apiKey: string
  text: string
  existingCommon: string[]
}

// Semantic match: asks Claude whether a freeform rejection reason maps
// to an existing chip. Returns the chip's canonical text (verbatim
// match from existingCommon) or null when there's no good fit.
export async function matchFreeformToChip(
  input: MatchInput,
): Promise<string | null> {
  if (input.existingCommon.length === 0) return null
  if (!input.text.trim()) return null
  const client = new Anthropic({ apiKey: input.apiKey })
  const userMessage = `Existing chips:\n${input.existingCommon
    .map((c) => `- ${c}`)
    .join('\n')}\n\nFreeform reason:\n"${input.text.trim()}"`
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 100,
    system: MATCH_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}'
  const parsed = safeParse(text)
  if (!parsed) return null
  const match = parsed.match
  if (typeof match !== 'string' || !match.trim()) return null
  // Verbatim guard: only accept matches that exist in the input list.
  // Haiku occasionally paraphrases despite the prompt; verbatim check
  // is the cheap safety net.
  const trimmed = match.trim()
  const hit = input.existingCommon.find((c) => c === trimmed)
  return hit ?? null
}

interface DistillSingleInput {
  apiKey: string
  text: string
  existingCommon: string[]
}

// Single-reason distillation: turns ONE freeform rejection reason into
// a short canonical chip label, immediately added to the pool on
// return. Returns null when the input can't be cleanly compressed.
export async function distillSingleReason(
  input: DistillSingleInput,
): Promise<string | null> {
  if (!input.text.trim()) return null
  const client = new Anthropic({ apiKey: input.apiKey })
  const existingList =
    input.existingCommon.length > 0
      ? input.existingCommon.map((c) => `- ${c}`).join('\n')
      : '(none yet)'
  const userMessage = `Existing chips (do not duplicate semantically):\n${existingList}\n\nFreeform reason to compress:\n"${input.text.trim()}"`
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 100,
    system: DISTILL_SINGLE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}'
  const parsed = safeParse(text)
  if (!parsed) return null
  const label = parsed.label
  if (typeof label !== 'string') return null
  const trimmed = label.trim()
  if (!trimmed) return null
  // Word-count guard — Haiku sometimes ignores the 2–4 word ceiling on
  // edge cases. Drop anything that violates so we don't spawn a
  // sentence-as-chip.
  const wordCount = trimmed.split(/\s+/).length
  if (wordCount < 1 || wordCount > 4) return null
  return trimmed
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const text = raw.trim()
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    const candidate = fenced ? fenced[1].trim() : text
    return JSON.parse(candidate)
  } catch {
    // Fallback: pull the largest {...} substring and try again.
    try {
      const first = raw.indexOf('{')
      const last = raw.lastIndexOf('}')
      if (first !== -1 && last > first) {
        return JSON.parse(raw.slice(first, last + 1))
      }
    } catch {
      // Give up — caller treats no-result as a no-op.
    }
    return null
  }
}
