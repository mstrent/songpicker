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
          content: `Which is the worship song "${query.title}" by ${query.author ?? 'unknown songwriter'}?\n\n${list}\n\nReply with only the number.`,
        },
      ],
    })

    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : ''
    const num = parseInt(text.trim(), 10)
    if (num >= 1 && num <= candidates.length) return num - 1
    return 0
  }
}
