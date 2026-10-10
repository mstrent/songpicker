import Anthropic from '@anthropic-ai/sdk'

import type { DisambiguationCandidate, LrclibQuery, LyricsDisambiguator } from './lrclib'

const MODEL = 'claude-haiku-5-5'

export function createLyricsDisambiguator(
  apiKey: string,
): LyricsDisambiguator {
  const client = new Anthropic({ apiKey })

  return async (
    query: LrclibQuery,
    candidates: DisambiguationCandidate[],
  ): Promise<number> => {
    const list = candidates
      .map(
        (c, i) =>
          `${i + 1}. ${c.artistName}${c.albumName ? ` (album: ${c.albumName})` : ''} — "${c.lyricsPreview}"`,
      )
      .join('\n')

    // Structured output rather than parsing an integer out of prose.
    // The enum bounds the answer to the candidates actually on offer
    // (plus 0 for "none of these"), so an out-of-range or non-numeric
    // reply isn't representable — the previous free-text parse silently
    // collapsed anything unexpected to -1 (= no match).
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 64,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              choice: {
                type: 'integer',
                enum: [0, ...candidates.map((_, i) => i + 1)],
                description:
                  'The 1-based number of the best-matching candidate, or 0 for none of them.',
              },
            },
            required: ['choice'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: 'user',
          content: `Which is the worship song titled "${query.title}"?

${list}

Note: the recording artist shown next to each option often differs from the songwriter credits ("${query.author ?? 'unknown'}") — that's normal for cover recordings, and is NOT a reason to reject a candidate.

Pick the number of the candidate that best matches a worship version of "${query.title}".

Reply with 0 ONLY if these are clearly not the worship song the user wants — for example, all candidates are secular pop/rock songs that happen to share the title, OR they are several completely different worship songs whose lyrics share no recognizable theme.`,
        },
      ],
    })

    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : ''
    let num: number
    try {
      num = (JSON.parse(text) as { choice: number }).choice
    } catch {
      return -1
    }
    if (num >= 1 && num <= candidates.length) return num - 1
    return -1
  }
}
