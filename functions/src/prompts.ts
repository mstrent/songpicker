import { getFirestore } from 'firebase-admin/firestore'

export type PromptType = 'structure' | 'role'

export const DEFAULT_STRUCTURE_PROMPT = `1 song for the opener: should be upbeat to wake people up. Then 3 songs after announcements: continuing the upbeat feel but moving toward slow and reflective to prepare folks for the message. Then 1 closing song which reinforces the theme (or call to action) and is somewhere in the "medium tempo" to "slow and reflective" range.`

// The editable "personality/role" portion of the system message.
export const DEFAULT_ROLE_PROMPT = `You suggest contemporary worship songs for a church service. Given a theme and criteria, return real, well-known worship songs that fit.`

// The non-editable technical instructions that constrain output format.
// These get appended to whatever role the user has configured before being
// sent as the model's system message. Kept hidden from the UI so users can
// freely edit the role without breaking JSON parsing.
const TECHNICAL_REQUIREMENTS = `Reply ONLY with JSON in this exact shape:
{"suggestions":[{"title":"Song Title","author":"Songwriter Name","reasoning":"why this fits","slots":["slot name"]}]}

When a "Service structure" is provided, identify the distinct song roles/slots it describes (e.g. "opener", "mid-service", "closer") and tag each suggestion's "slots" with the slot(s) it would fit — a song may fit multiple slots. Return at least 4 suggestions tagged for each slot, even if that exceeds the user's requested total. When no service structure is provided, omit "slots" or use an empty array.

Do not invent songs that don't exist.`

export function builtInFor(type: PromptType): string {
  return type === 'role' ? DEFAULT_ROLE_PROMPT : DEFAULT_STRUCTURE_PROMPT
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
  const doc = await loadDoc(uid)
  const section = doc[type]
  const builtIn = builtInFor(type)
  const planOverride = planId ? (section.byPlan[planId] ?? '') : ''
  const userDefault = section.default

  let value = builtIn
  let source: 'plan' | 'user' | 'system' = 'system'
  if (planOverride.trim()) {
    value = planOverride
    source = 'plan'
  } else if (userDefault.trim()) {
    value = userDefault
    source = 'user'
  }
  return { builtIn, userDefault, planOverride, effective: { value, source } }
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
