import { createHash } from 'node:crypto'

import type { Firestore } from 'firebase-admin/firestore'

import { normalizeText } from '../normalize'

// Lyrics cache lives in a top-level Firestore collection because the
// data is identical across users — the same song has the same lyrics
// regardless of which Planning Center library it came from. Sharing
// the cache means we pay LRCLIB once per song globally rather than
// once per user. Client access is denied (see firestore.rules); only
// the getLyrics callable reads/writes via admin SDK.
const COLLECTION = 'lyrics'

export interface LyricsCacheEntry {
  found: boolean
  plainLyrics: string | null
  instrumental: boolean
  lrclibId: number | null
  source: 'lrclib'
  fetchedAt: number
}

interface LyricsCacheDoc extends LyricsCacheEntry {
  // Stored for human debugging only. Lookups go through lyricsCacheKey
  // which normalizes — these strings reflect what the caller sent.
  title: string
  author: string
}

export function lyricsCacheKey(title: string, author?: string): string {
  const t = normalizeText(title)
  const a = normalizeText(author ?? '')
  return createHash('sha1').update(`${t}|${a}`).digest('hex')
}

export async function readLyricsCache(
  db: Firestore,
  title: string,
  author: string | undefined,
): Promise<LyricsCacheEntry | null> {
  const key = lyricsCacheKey(title, author)
  const snap = await db.collection(COLLECTION).doc(key).get()
  if (!snap.exists) return null
  const data = snap.data() as LyricsCacheDoc | undefined
  if (!data) return null
  return {
    found: data.found,
    plainLyrics: data.plainLyrics,
    instrumental: data.instrumental,
    lrclibId: data.lrclibId,
    source: data.source,
    fetchedAt: data.fetchedAt,
  }
}

export async function writeLyricsCache(
  db: Firestore,
  title: string,
  author: string | undefined,
  result: {
    found: boolean
    plainLyrics: string | null
    instrumental: boolean
    lrclibId: number | null
  },
  now: () => number = Date.now,
): Promise<void> {
  const key = lyricsCacheKey(title, author)
  const doc: LyricsCacheDoc = {
    title,
    author: author ?? '',
    found: result.found,
    plainLyrics: result.plainLyrics,
    instrumental: result.instrumental,
    lrclibId: result.lrclibId,
    source: 'lrclib',
    fetchedAt: now(),
  }
  await db.collection(COLLECTION).doc(key).set(doc)
}
