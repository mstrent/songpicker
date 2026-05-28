import Anthropic from '@anthropic-ai/sdk'

import type { DisambiguationCandidate, LrclibQuery, LyricsDisambiguator } from './lrclib'

const MODEL = 'claude-haiku-4-5-20251001'

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

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: `Which is the worship song titled "${query.title}"?

${list}

Note: the recording artist shown next to each option often differs from the songwriter credits ("${query.author ?? 'unknown'}") — that's normal for cover recordings, and is NOT a reason to reject a candidate.

Pick the number of the candidate that best matches a worship version of "${query.title}".

Reply with 0 ONLY if these are clearly not the worship song the user wants — for example, all candidates are secular pop/rock songs that happen to share the title, OR they are several completely different worship songs whose lyrics share no recognizable theme.

Reply with only the number, no other text.`,
        },
      ],
    })

    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : ''
    const num = parseInt(text.trim(), 10)
    if (num >= 1 && num <= candidates.length) return num - 1
    if (num === 0) return -1
    return -1
  }
}
