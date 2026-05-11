import { GoogleGenAI } from '@google/genai'
import { buildUserMessage } from './userMessage'
import type { AiProvider, SongSuggestion, SuggestRequest, SuggestResult } from './types'

const SYSTEM_PROMPT = `You suggest contemporary worship songs for a church service.
Given a theme and criteria, return real, well-known worship songs that fit.
Reply ONLY with JSON in this exact shape:
{"suggestions":[{"title":"Song Title","author":"Songwriter Name","reasoning":"why this fits"}]}
Return exactly the requested count. Do not invent songs that don't exist.`

const MODEL = 'gemini-2.5-flash'

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const
  private client: GoogleGenAI

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey })
  }

  async suggestSongs(req: SuggestRequest): Promise<SuggestResult> {
    const userMessage = buildUserMessage(req)
    const res = await this.client.models.generateContent({
      model: MODEL,
      contents: userMessage,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
      },
    })

    const text = res.text ?? '{}'
    const parsed = JSON.parse(text) as { suggestions?: SongSuggestion[] }
    return {
      suggestions: parsed.suggestions ?? [],
      debug: { model: MODEL, systemPrompt: SYSTEM_PROMPT, userMessage },
    }
  }
}
