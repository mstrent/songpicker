import { getFirestore } from 'firebase-admin/firestore'

export const DEFAULT_STRUCTURE_PROMPT = `1 song for the opener: should be upbeat to wake people up. Then 3 songs after announcements: continuing the upbeat feel but moving toward slow and reflective to prepare folks for the message. Then 1 closing song which reinforces the theme (or call to action) and is somewhere in the "medium tempo" to "slow and reflective" range.`

interface UserPromptDoc {
  default?: string
  byPlan?: Record<string, string>
}

const collection = 'userPrompts'

async function loadDoc(uid: string): Promise<UserPromptDoc> {
  const snap = await getFirestore().doc(`${collection}/${uid}`).get()
  if (!snap.exists) return {}
  return (snap.data() as UserPromptDoc) ?? {}
}

export async function loadPromptConfig(
  uid: string,
): Promise<{ systemDefault: string; userDefault: string; byPlan: Record<string, string> }> {
  const data = await loadDoc(uid)
  return {
    systemDefault: DEFAULT_STRUCTURE_PROMPT,
    userDefault: typeof data.default === 'string' ? data.default : '',
    byPlan:
      data.byPlan && typeof data.byPlan === 'object' ? { ...data.byPlan } : {},
  }
}

export function resolveStructurePrompt(
  config: { systemDefault: string; userDefault: string; byPlan: Record<string, string> },
  planId?: string,
): { value: string; source: 'plan' | 'user' | 'system' } {
  if (planId) {
    const override = config.byPlan[planId]
    if (override && override.trim()) return { value: override, source: 'plan' }
  }
  if (config.userDefault.trim()) return { value: config.userDefault, source: 'user' }
  return { value: config.systemDefault, source: 'system' }
}

export async function saveUserDefault(uid: string, value: string): Promise<void> {
  await getFirestore()
    .doc(`${collection}/${uid}`)
    .set({ default: value }, { merge: true })
}

export async function savePlanOverride(
  uid: string,
  planId: string,
  value: string,
): Promise<void> {
  await getFirestore()
    .doc(`${collection}/${uid}`)
    .set({ byPlan: { [planId]: value } }, { merge: true })
}

export async function clearPlanOverride(uid: string, planId: string): Promise<void> {
  const data = await loadDoc(uid)
  if (!data.byPlan?.[planId]) return
  const next = { ...data.byPlan }
  delete next[planId]
  await getFirestore()
    .doc(`${collection}/${uid}`)
    .set({ byPlan: next }, { merge: true })
}
