import { getFirestore } from 'firebase-admin/firestore'

export type PromptType = 'structure' | 'role'

export const DEFAULT_STRUCTURE_PROMPT = `1 song for the opener: should be upbeat to wake people up. Then 3 or 4 songs after in the middle after announcements: continue the upbeat feel but move toward slow and reflective to prepare folks for the message. Then 1 closing song which reinforces the theme (or call to action) and is somewhere in the "medium tempo" to "slow and reflective" range.`

// The editable "personality/role" portion of the system message.
export const DEFAULT_ROLE_PROMPT = `You suggest contemporary worship songs for a church service. Given a theme and criteria, return real, well-known worship songs that fit.`

// The non-editable technical instructions that constrain output format.
// These get appended to whatever role the user has configured before being
// sent as the model's system message. Kept hidden from the UI so users can
// freely edit the role without breaking JSON parsing. The admin page
// surfaces this constant read-only for debugging.
export const TECHNICAL_REQUIREMENTS = `Reply ONLY with JSON in this exact shape:
{"suggestions":[{"title":"Song Title","author":"Songwriter Name","chorusSnippet":"1-2 memorable lines from the chorus","slots":["slot name"]}]}

The chorusSnippet should be one or two recognisable lines from the song's chorus so the user can confirm which song this is at a glance — different songs share titles, but rarely lyrics. Keep it under 100 characters. Quote the actual chorus, don't paraphrase. If you genuinely don't know the lyrics, omit the field rather than invent.

When a "Service structure" is provided, identify the distinct song roles/slots it describes (e.g. "opener", "mid-service", "closer") and tag each suggestion's "slots" with the slot(s) it would fit — a song may fit multiple slots.

Cross-reference these slots against the "Current service order" (when provided). Any slot whose corresponding service-order item is already filled (shown with "— picked: <title>") is DONE — do not propose songs for it. Focus all suggestions on the slots whose service-order items are still marked "(empty, needs a pick)".

Within the user's requested min–max range, try to cover every unfilled slot with at least 3 options so the user has real choice; only fall below that when the requested maximum doesn't leave room. Never exceed the requested maximum. When no service structure is provided, omit "slots" or use an empty array.

Do not invent songs that don't exist.`

export function hardcodedDefaultFor(type: PromptType): string {
  return type === 'role' ? DEFAULT_ROLE_PROMPT : DEFAULT_STRUCTURE_PROMPT
}

// Admin-owned overrides live in a single global doc; if a type isn't
// overridden the hardcoded default applies.
const adminCollection = 'appConfig'
const adminDocId = 'global'

interface AdminPromptDoc {
  structure?: string
  role?: string
}

export async function loadAdminDefaults(): Promise<{
  structure: string
  role: string
}> {
  const snap = await getFirestore().doc(`${adminCollection}/${adminDocId}`).get()
  const data = (snap.exists ? (snap.data() as AdminPromptDoc) : null) ?? {}
  return {
    structure: typeof data.structure === 'string' ? data.structure : '',
    role: typeof data.role === 'string' ? data.role : '',
  }
}

export async function saveAdminDefault(
  type: PromptType,
  value: string,
): Promise<void> {
  await getFirestore()
    .doc(`${adminCollection}/${adminDocId}`)
    .set({ [type]: value }, { merge: true })
}

// Returns the system-wide default for a prompt type: admin override if set,
// otherwise the hardcoded constant.
export async function effectiveSystemDefault(type: PromptType): Promise<string> {
  const admin = await loadAdminDefaults()
  const candidate = admin[type]
  if (candidate.trim()) return candidate
  return hardcodedDefaultFor(type)
}

// Combine the user-editable role with the always-on technical requirements
// into the literal system message the model receives.
export function composeSystemPrompt(role: string): string {
  return `${role.trim()}\n\n${TECHNICAL_REQUIREMENTS}`
}

interface PromptSection {
  default: string
  byPlan: Record<string, string>
}

interface UserPromptDoc {
  structure: PromptSection
  role: PromptSection
  themes: Record<string, string>
  notes: Record<string, string>
}

const collection = 'userPrompts'

async function loadDoc(uid: string): Promise<UserPromptDoc> {
  const snap = await getFirestore().doc(`${collection}/${uid}`).get()
  const raw = (snap.exists ? snap.data() : null) as Record<string, unknown> | null
  // Backward-compat reads:
  //   * older flat shape — top-level `default` / `byPlan` was the structure prompt
  //   * earlier nested shape — `system` section is now `role`
  const structRaw = (raw?.structure ?? {}) as Record<string, unknown>
  const roleRaw =
    (raw?.role as Record<string, unknown> | undefined) ??
    (raw?.system as Record<string, unknown> | undefined) ??
    {}
  return {
    structure: {
      default:
        typeof structRaw.default === 'string'
          ? structRaw.default
          : typeof raw?.default === 'string'
            ? (raw.default as string)
            : '',
      byPlan:
        (structRaw.byPlan as Record<string, string> | undefined) ??
        (raw?.byPlan as Record<string, string> | undefined) ??
        {},
    },
    role: {
      default: typeof roleRaw.default === 'string' ? roleRaw.default : '',
      byPlan: (roleRaw.byPlan as Record<string, string> | undefined) ?? {},
    },
    themes:
      (raw?.themes as Record<string, string> | undefined) ?? {},
    notes:
      (raw?.notes as Record<string, string> | undefined) ?? {},
  }
}

export async function loadUserTheme(
  uid: string,
  planId: string,
): Promise<string> {
  const doc = await loadDoc(uid)
  return doc.themes[planId] ?? ''
}

export async function saveUserTheme(
  uid: string,
  planId: string,
  theme: string,
): Promise<void> {
  await getFirestore()
    .doc(`${collection}/${uid}`)
    .set({ themes: { [planId]: theme } }, { merge: true })
}

export async function loadUserNotes(
  uid: string,
  planId: string,
): Promise<string> {
  const doc = await loadDoc(uid)
  return doc.notes[planId] ?? ''
}

export async function saveUserNotes(
  uid: string,
  planId: string,
  notes: string,
): Promise<void> {
  await getFirestore()
    .doc(`${collection}/${uid}`)
    .set({ notes: { [planId]: notes } }, { merge: true })
}

export interface ResolvedPrompt {
  builtIn: string
  userDefault: string
  planOverride: string
  effective: { value: string; source: 'plan' | 'user' | 'system' }
}

export async function loadResolved(
  uid: string,
  type: PromptType,
  planId?: string,
): Promise<ResolvedPrompt> {
  const [doc, systemDefault] = await Promise.all([
    loadDoc(uid),
    effectiveSystemDefault(type),
  ])
  const section = doc[type]
  const planOverride = planId ? (section.byPlan[planId] ?? '') : ''
  const userDefault = section.default

  let value = systemDefault
  let source: 'plan' | 'user' | 'system' = 'system'
  if (planOverride.trim()) {
    value = planOverride
    source = 'plan'
  } else if (userDefault.trim()) {
    value = userDefault
    source = 'user'
  }
  return { builtIn: systemDefault, userDefault, planOverride, effective: { value, source } }
}

export async function saveUserDefault(
  uid: string,
  type: PromptType,
  value: string,
): Promise<void> {
  await getFirestore()
    .doc(`${collection}/${uid}`)
    .set({ [type]: { default: value } }, { merge: true })
}

export async function savePlanOverride(
  uid: string,
  type: PromptType,
  planId: string,
  value: string,
): Promise<void> {
  await getFirestore()
    .doc(`${collection}/${uid}`)
    .set({ [type]: { byPlan: { [planId]: value } } }, { merge: true })
}

export async function clearPlanOverride(
  uid: string,
  type: PromptType,
  planId: string,
): Promise<void> {
  const doc = await loadDoc(uid)
  const section = doc[type]
  if (!section.byPlan[planId]) return
  const next = { ...section.byPlan }
  delete next[planId]
  await getFirestore()
    .doc(`${collection}/${uid}`)
    .set({ [type]: { byPlan: next } }, { merge: true })
}
