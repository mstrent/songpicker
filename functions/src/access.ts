import { getFirestore } from 'firebase-admin/firestore'

// Firestore-resident allowed/admin email lists. Source of truth for who
// can use the app and who can edit system-wide config, so the lists
// survive a lost laptop and can be edited from the Admin UI without a
// redeploy.
//
// The env-based ALLOWED_EMAIL / ADMIN_EMAILS lists stay in place as a
// permanent break-glass root: their entries are always honored and
// can't be removed from the UI. That guarantees at least one operator
// can always log in to recover access even if Firestore data is wrong
// or wiped.
//
// Final auth decision: env ∪ Firestore.

export type AccessList = 'allowed' | 'admin'

export interface AccessDoc {
  allowedEmails: string[]
  adminEmails: string[]
}

const DOC_PATH = 'appConfig/access'

function empty(): AccessDoc {
  return { allowedEmails: [], adminEmails: [] }
}

function sanitizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => entryIsValid(s))
}

function sanitize(raw: unknown): AccessDoc {
  if (!raw || typeof raw !== 'object') return empty()
  const d = raw as Record<string, unknown>
  return {
    allowedEmails: sanitizeList(d.allowedEmails),
    adminEmails: sanitizeList(d.adminEmails),
  }
}

// Bare "@" without a domain would silently match every email; require
// at least one char after.
export function entryIsValid(entry: string): boolean {
  const s = entry.trim().toLowerCase()
  if (!s) return false
  if (s.startsWith('@')) return s.length > 1 && !s.slice(1).includes('@')
  const at = s.indexOf('@')
  return at > 0 && at === s.lastIndexOf('@') && at < s.length - 1
}

// Module-level cache. Each function instance has its own; the 60s TTL
// is the cap on how long a UI add/remove takes to propagate to other
// running instances. Writes through addEntry/removeEntry also clear
// this instance's cache so the editing admin sees their change
// immediately.
const CACHE_TTL_MS = 60 * 1000
let cache: { doc: AccessDoc; fetchedAt: number } | null = null

async function loadDoc(): Promise<AccessDoc> {
  const snap = await getFirestore().doc(DOC_PATH).get()
  if (!snap.exists) return empty()
  return sanitize(snap.data())
}

export async function getAccess(): Promise<AccessDoc> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.doc
  const doc = await loadDoc()
  cache = { doc, fetchedAt: now }
  return doc
}

function invalidateCache(): void {
  cache = null
}

// Match an email against an entry list. Entries are either exact emails
// ("matt@thetrents.org") or domain wildcards starting with "@"
// ("@thetrents.org"). The list is assumed pre-sanitized (lowercased,
// validated); see sanitizeList / entryIsValid.
export function emailMatchesEntries(entries: string[], email: string): boolean {
  if (entries.length === 0) return false
  const emailLc = email.toLowerCase()
  const atIdx = emailLc.lastIndexOf('@')
  const domain = atIdx >= 0 ? emailLc.slice(atIdx) : ''
  return entries.some((entry) =>
    entry.startsWith('@') ? entry === domain : entry === emailLc,
  )
}

export async function addAccessEntry(
  list: AccessList,
  entry: string,
): Promise<AccessDoc> {
  const normalized = entry.trim().toLowerCase()
  if (!entryIsValid(normalized)) {
    throw new Error(
      'Entry must be a full email ("name@example.com") or a domain wildcard ("@example.com").',
    )
  }
  const doc = await loadDoc()
  const field = list === 'allowed' ? 'allowedEmails' : 'adminEmails'
  if (doc[field].includes(normalized)) return doc
  const next: AccessDoc = {
    ...doc,
    [field]: [...doc[field], normalized],
  }
  await getFirestore()
    .doc(DOC_PATH)
    .set({ ...next, updatedAt: new Date() }, { merge: true })
  invalidateCache()
  return next
}

export async function removeAccessEntry(
  list: AccessList,
  entry: string,
): Promise<AccessDoc> {
  const normalized = entry.trim().toLowerCase()
  const doc = await loadDoc()
  const field = list === 'allowed' ? 'allowedEmails' : 'adminEmails'
  if (!doc[field].includes(normalized)) return doc
  const next: AccessDoc = {
    ...doc,
    [field]: doc[field].filter((e) => e !== normalized),
  }
  await getFirestore()
    .doc(DOC_PATH)
    .set({ ...next, updatedAt: new Date() }, { merge: true })
  invalidateCache()
  return next
}
