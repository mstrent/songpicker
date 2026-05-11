import { getFirestore } from 'firebase-admin/firestore'

export type PromptType = 'structure' | 'system'

export const DEFAULT_STRUCTURE_PROMPT = `1 song for the opener: should be upbeat to wake people up. Then 3 songs after announcements: continuing the upbeat feel but moving toward slow and reflective to prepare folks for the message. Then 1 closing song which reinforces the theme (or call to action) and is somewhere in the "medium tempo" to "slow and reflective" range.`

export const DEFAULT_SYSTEM_PROMPT = `You suggest contemporary worship songs for a church service.
Given a theme and criteria, return real, well-known worship songs that fit.
Reply ONLY with JSON in this exact shape:
{"suggestions":[{"title":"Song Title","author":"Songwriter Name","reasoning":"why this fits"}]}
Return exactly the requested count. Do not invent songs that don't exist.`

export function builtInFor(type: PromptType): string {
  return type === 'system' ? DEFAULT_SYSTEM_PROMPT : DEFAULT_STRUCTURE_PROMPT
}

interface PromptSection {
  default: string
  byPlan: Record<string, string>
}

interface UserPromptDoc {
  structure: PromptSection
  system: PromptSection
}

const collection = 'userPrompts'

async function loadDoc(uid: string): Promise<UserPromptDoc> {
  const snap = await getFirestore().doc(`${collection}/${uid}`).get()
  const raw = (snap.exists ? snap.data() : null) as Record<string, unknown> | null
  // Backward-compat: an earlier version stored structure prompts at the top
  // level (`default`, `byPlan`) without a section nesting. Read both shapes,
  // preferring the new nested one. Writes always use the new layout.
  const structRaw = (raw?.structure ?? {}) as Record<string, unknown>
  const sysRaw = (raw?.system ?? {}) as Record<string, unknown>
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
    system: {
      default: typeof sysRaw.default === 'string' ? sysRaw.default : '',
      byPlan: (sysRaw.byPlan as Record<string, string> | undefined) ?? {},
    },
  }
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
