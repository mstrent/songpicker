import Anthropic from '@anthropic-ai/sdk'

// Standalone Claude call: turns a pile of freeform "why I rejected this
// song" reasons into a small set of short, generic chip-worthy
// categories that aren't already in the existing common list. Kept out
// of the AiProvider abstraction because the prompt and the response
// shape are unique to this purpose — `suggestSongs` shouldn't carry
// the weight of a second contract.

const MODEL = 'claude-sonnet-4-6'

const SYSTEM_PROMPT = `You help maintain a short list of "common rejection reasons" shown as one-tap chips in a worship-song picker. A user clicks Reject on an AI-suggested song and is invited to leave a freeform reason. You see the recent freeform reasons (raw, in the user's own words) plus the existing chip list.

Your job: propose up to 5 NEW concise reason chips that capture themes appearing repeatedly in the freeform list but NOT already covered by the existing chips. Each chip:
- 2–5 words.
- Self-contained — readable without context, the way a button label is.
- Phrased neutrally ("Too slow", "Already played recently", "Doesn't fit theme") — not "the user said X".
- No duplicates of existing chips, even paraphrased.

If the freeform reasons don't reveal any new common themes, return an empty array. Don't pad.

Reply ONLY with JSON in this exact shape:
{"reasons":["Too slow","Already played recently"]}`

interface DistillInput {
  apiKey: string
  existingCommon: string[]
  recentFreeform: string[]
}

export async function distillRejectionReasons(
  input: DistillInput,
): Promise<string[]> {
  if (input.recentFreeform.length === 0) return []
  const client = new Anthropic({ apiKey: input.apiKey })
  const userMessage = buildUserMessage(input)
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}'
  const parsed = safeParse(text)
  if (!parsed) return []
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons : []
  return reasons
    .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    .map((r) => r.trim())
    .slice(0, 5)
}

function buildUserMessage(input: DistillInput): string {
  const parts: string[] = []
  if (input.existingCommon.length > 0) {
    parts.push(
      `Existing chips:\n${input.existingCommon.map((c) => `- ${c}`).join('\n')}`,
    )
  } else {
    parts.push('Existing chips: (none yet)')
  }
  parts.push(
    `Recent freeform rejection reasons (${input.recentFreeform.length} entries, oldest first):`,
  )
  parts.push(input.recentFreeform.map((r) => `- ${r}`).join('\n'))
  return parts.join('\n\n')
}

function safeParse(raw: string): { reasons?: unknown } | null {
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
