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

When a "Service structure" is provided, parse it into the distinct conceptual song roles it describes (e.g. "opener", "mid-service", "closer"). These role names — taken from the structure prompt itself — are what each suggestion's "slots" field should contain. A song may fit multiple roles, so the array can list more than one. The "Current service order" uses position tags like "[song slot 2 of 4]" purely to indicate position; these are NOT slot names. NEVER tag a suggestion with a position label like "song slot 2" or "slot 3"; always use the conceptual role names from the structure prompt.

If a "Current service order" is also provided, map each "[song slot N of M]" position to a structure role by its sequence: slot 1 of M is the opener role, slot M of M is the closer role, and slots in between are the mid-service / middle roles described by the structure. Then: any role whose positions are all already filled (marked "— picked: <title>") is DONE — do not suggest more songs for it. Focus suggestions on the roles that still have positions marked "(empty, needs a pick)".

Within the user's requested min–max range, try to cover every still-needed role with at least 3 options so the user has real choice; only fall below that when the requested maximum doesn't leave room. Never exceed the requested maximum. When no service structure is provided, omit "slots" or use an empty array.

When a "Current candidates" section is provided, treat every entry as already on the user's radar — never propose a song whose title already appears there, regardless of decision (pending, shortlisted, rejected, committed). Rejected entries especially: the user explicitly said no, so don't re-pitch them even with a different framing. Use the entries' decisions, slot earmarks, reject reasons, and chorus snippets to understand what direction the user is converging on, and let that shape what you suggest next. The same goes for any titles in "Already in plan" — those songs are taken.

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
