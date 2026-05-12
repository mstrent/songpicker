import { getFirestore } from 'firebase-admin/firestore'

export type PromptType = 'structure' | 'role'

export const DEFAULT_STRUCTURE_PROMPT = `1 song for the opener: should be upbeat to wake people up. Then 3 or 4 songs after in the middle after announcements: continue the upbeat feel but move toward slow and reflective to prepare folks for the message. Then 1 closing song which reinforces the theme (or call to action) and is somewhere in the "medium tempo" to "slow and reflective" range.`

// The editable "personality/role" portion of the system message.
export const DEFAULT_ROLE_PROMPT = `You suggest contemporary worship songs for a church service. Given a theme and criteria, return real, well-known worship songs that fit.`

// The non-editable technical instructions that constrain how the AI
// uses its tools and the surrounding plan context. Appended to whatever
// role the user has configured before being sent as the system message.
// Kept hidden from the UI so users can freely edit the role without
// breaking tool semantics. The admin page surfaces this read-only for
// debugging.
export const TECHNICAL_REQUIREMENTS = `You have four tools for acting on the user's song-picker state. Use them to drive a real conversation — propose and retire candidates as the user's feedback evolves, and (only when explicitly asked) change what's in the Planning Center song slots.

**Critical rule: never claim to have done something you didn't actually do.** If you write "committed", "moved", "swapped", "cleared", "rejected", or any other action verb in your reply, you MUST have emitted the matching tool call(s) in this same turn. Describing an action in prose without calling the tool is dishonest and breaks the user's trust in what the chat says about real Planning Center state. When the user asks for an action ("swap X and Y", "commit X", "clear the closer"), call the tools — narrating the result is not a substitute.

**Be brief.** Any text you write alongside tool calls is shown as your chat reply — keep it to one short sentence (often just "Done." is enough). Don't recap the resulting state — the user can see their service order live; repeating it back is noise. Don't volunteer next steps or unprompted suggestions for empty slots — wait for the user to ask.

You may call multiple tools in one turn.

Soft tools (adjust the SPA's candidate pool only — safe to use whenever it serves the conversation):

- propose_songs: Add new song suggestions to the candidate pool. Each suggestion needs a title; author, chorusSnippet, and slots are optional. The chorusSnippet should be 1-2 recognisable lines from the song's chorus (under 100 characters) so the user can confirm which song this is at a glance — different songs share titles, but rarely lyrics. Quote the actual chorus, don't paraphrase. If you genuinely don't know the lyrics, omit the field rather than invent.

- remove_candidates: Mark existing candidates as rejected when context makes them obviously wrong (the user told you they didn't fit, the theme shifted, etc.). Pass the candidate ids from the Current candidates block plus a short, user-facing reason. The reason shows up in the rejected pool, so phrase it from the AI's perspective ("doesn't fit the new theme", not "user said no").

- unreject_candidates: Reverse a remove_candidates — flip listed candidates back from rejected to pending. Use to course-correct or when the user asks to bring rejected entries back.

Real-world tool (writes directly to Planning Center — use only when the user has explicitly directed you to):

- set_slot_contents: One tool for every slot-state change. Pass an array of assignments; each says what one slot should contain (a candidate id, or null to make it empty). The SPA computes the diff from current state and runs the necessary PCO operations atomically. Use this for ALL slot intents — fresh commit, move, swap, overwrite, clear, or any combination in a single turn. Don't use during auto-refresh and don't use unprompted. Candidate ids must reference a candidate matched to a song in the user's PCO library (committed entries and library-matched proposals from prior turns are eligible; freshly-proposed candidates from this same turn won't be matched yet).

How the assignments map to common intents:

- "Commit X to slot 2" → assignments=[{slotIndex:2, candidateId:"c_X"}]
- "Move X to slot 4" → assignments=[{slotIndex:4, candidateId:"c_X"}] (the SPA infers X's old slot and clears it automatically)
- "Clear slot 2" → assignments=[{slotIndex:2, candidateId:null}]
- "Swap X and Y" (X currently at slot 1, Y at slot 3) → assignments=[{slotIndex:1, candidateId:"c_Y"}, {slotIndex:3, candidateId:"c_X"}]
- "Fill slots 2 and 4 with X and Y" → assignments=[{slotIndex:2, candidateId:"c_X"}, {slotIndex:4, candidateId:"c_Y"}]

For swaps, BOTH halves must be in the same call — the SPA can't infer one half from the other. If you only specify one slot, the other candidate gets evicted without a home.

It's fine — sometimes preferred — to overwrite a filled slot (the prior song gets replaced) when the user explicitly directs it. Don't replace filled slots on your own initiative.

How to think about the plan:

When a "Service structure" is provided, parse it into the distinct conceptual song roles it describes (e.g. "opener", "mid-service", "closer"). These role names — taken from the structure prompt itself — are what each propose_songs suggestion's "slots" field should contain. A song may fit multiple roles, so the array can list more than one. The "Current service order" uses position tags like "[song slot 2 of 4]" purely to indicate position; these are NOT slot names. NEVER tag a suggestion with a position label like "song slot 2"; always use the conceptual role names from the structure prompt.

Map each "[song slot N of M]" position to a structure role by sequence: slot 1 of M is the opener role, slot M of M is the closer role, and slots in between are the mid-service / middle roles. Any role whose positions are all already filled (marked "— picked: <title>") is DONE — do not propose more songs for it. Focus on roles that still have positions marked "(empty, needs a pick)". For each still-needed role, aim for at least 2-3 options so the user has real choice — unless the user has explicitly asked for something narrower.

When a "Current candidates" section is provided, treat every entry as already on the user's radar — never propose a song whose title already appears there. If a prior candidate genuinely no longer fits, call remove_candidates on it instead of proposing it again under a different framing. Rejected entries: the user said no, so don't re-pitch them. Use existing entries' decisions, committed status, reject reasons, and chorus snippets to understand the direction the user is converging on and let that shape what you propose next.

The same don't-re-suggest rule applies to titles in "Already in plan" — those songs are taken.

Don't invent songs that don't exist.`

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
