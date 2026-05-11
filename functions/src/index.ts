import { initializeApp } from 'firebase-admin/app'
import { setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'

import { getAiProvider } from './ai'
import { PcoClient } from './pco/client'
import { pMap } from './pco/concurrency'
import {
  hasPcoCredentials,
  pcoForUser,
  savePcoCredentialsForUser,
} from './pco/credentials'
import { countSongs } from './pco/songSlots'
import type { NewItem } from './pco/types'
import {
  TECHNICAL_REQUIREMENTS,
  clearPlanOverride,
  composeSystemPrompt,
  hardcodedDefaultFor,
  loadAdminDefaults,
  loadResolved,
  loadUserNotes,
  loadUserTheme,
  saveAdminDefault,
  savePlanOverride,
  saveUserDefault,
  saveUserNotes,
  saveUserTheme,
  type PromptType,
} from './prompts'
import {
  loadPickerSession,
  savePickerSession,
  type PickerSession,
} from './sessions'
import {
  ADMIN_EMAILS,
  AI_PROVIDER,
  ALLOWED_EMAIL,
  ANTHROPIC_API_KEY,
  GEMINI_API_KEY,
  INCLUDED_SERVICE_TYPES,
} from './config'

initializeApp()
setGlobalOptions({ region: 'us-central1', maxInstances: 10 })

function isAdminEmail(email: string): boolean {
  const admins = ADMIN_EMAILS.value()
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return admins.length > 0 && admins.includes(email.toLowerCase())
}

function requireAdmin(req: CallableRequest<unknown>): { uid: string; email: string } {
  const auth = requireAllowed(req)
  if (!isAdminEmail(auth.email)) {
    throw new HttpsError('permission-denied', 'Admin only')
  }
  return auth
}

function requireAllowed(req: CallableRequest<unknown>): { uid: string; email: string } {
  const email = req.auth?.token?.email
  const uid = req.auth?.uid
  if (!email || !uid) throw new HttpsError('unauthenticated', 'Sign in required')
  const allowed = ALLOWED_EMAIL.value()
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (allowed.length > 0 && !allowed.includes(email.toLowerCase())) {
    throw new HttpsError('permission-denied', `Not authorized: ${email}`)
  }
  return { uid, email }
}

// Returns whether the calling user has saved their PCO PAT. SPA uses this
// to decide whether to show the setup screen or the main app.
export const getPcoStatus = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  return { hasCredentials: await hasPcoCredentials(uid) }
})

// Validate that the supplied PCO PAT works by hitting /service_types, then
// store it in Firestore. Bad creds bubble back to the SPA so the user
// retries instead of silently saving a wrong key.
export const savePcoCredentials = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { appId, secret } = req.data as { appId?: unknown; secret?: unknown }
  if (typeof appId !== 'string' || typeof secret !== 'string' || !appId.trim() || !secret.trim()) {
    throw new HttpsError('invalid-argument', 'appId and secret required')
  }
  const client = new PcoClient(appId.trim(), secret.trim())
  try {
    await client.listServiceTypes()
  } catch (e) {
    throw new HttpsError(
      'failed-precondition',
      `Planning Center rejected those credentials: ${(e as Error).message}`,
    )
  }
  await savePcoCredentialsForUser(uid, appId.trim(), secret.trim())
  return { ok: true }
})

export const listPlans = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const allowed = INCLUDED_SERVICE_TYPES.value()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const client = await pcoForUser(uid)
  // 4 past plans per service type (~1 month of weekly services) gives
  // recent-history context alongside the upcoming list.
  const all = await client.listAllPlans({ past: 4, future: 10 })
  const filtered = allowed.length
    ? all.filter((p) => p.serviceTypeName != null && allowed.includes(p.serviceTypeName))
    : all

  // Enrich each plan with its worship-team roster (name + email + position
  // + team) so the SPA can do both the "led by …" display and the
  // "you're serving / leading" highlights without further server calls.
  // Scoped to worship team only — songpicker's whole job is worship songs,
  // so other rosters (tech, kids, greeters) are noise here. Matches any
  // team name containing "worship" (case-insensitive) so "Worship Team",
  // "Worship Band", etc. all qualify.
  // Parallel fetch keeps total latency ~one PCO round-trip even with N
  // plans; per-plan failures are swallowed so one bad plan doesn't blank
  // the whole list.
  // Bounded concurrency: each plan triggers two PCO calls (people +
  // items). Capping at 4 plans in flight = up to 8 in-flight PCO calls
  // for enrichment, well under the 100 req/20s ceiling even with the
  // other listAllPlans calls already spent.
  const plans = await pMap(
    filtered,
    async (p) => {
      try {
        const [people, items] = await Promise.all([
          client.listPlanPeople(p.serviceTypeId, p.id),
          client.listPlanItems(p.serviceTypeId, p.id),
        ])
        const teamMembers = people
          .filter((pp) => pp.status !== 'D')
          .filter((pp): pp is typeof pp & { name: string } => !!pp.name)
          .filter((pp) => /worship/i.test(pp.team ?? ''))
          .map((pp) => ({
            name: pp.name,
            email: pp.email,
            position: pp.position,
            team: pp.team,
          }))
        const songCounts = countSongs(items)
        return { ...p, teamMembers, songCounts }
      } catch {
        return p
      }
    },
    4,
  )
  return { plans }
})

export const getPlanContext = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { serviceTypeId, planId } = req.data as {
    serviceTypeId?: string
    planId?: string
  }
  if (!serviceTypeId || !planId) {
    throw new HttpsError('invalid-argument', 'serviceTypeId and planId required')
  }
  const client = await pcoForUser(uid)
  const [plan, notes, items, userTheme, userNotes] = await Promise.all([
    client.getPlan(serviceTypeId, planId),
    client.getPlanNotes(serviceTypeId, planId),
    client.listPlanItems(serviceTypeId, planId),
    loadUserTheme(uid, planId),
    loadUserNotes(uid, planId),
  ])
  return { plan, notes, items, userTheme, userNotes }
})

export const savePlanTheme = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { planId, theme } = req.data as { planId?: string; theme?: string }
  if (!planId) throw new HttpsError('invalid-argument', 'planId required')
  if (typeof theme !== 'string') {
    throw new HttpsError('invalid-argument', 'theme (string) required')
  }
  await saveUserTheme(uid, planId, theme)
  return { ok: true }
})

export const savePlanNotes = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { planId, notes } = req.data as { planId?: string; notes?: string }
  if (!planId) throw new HttpsError('invalid-argument', 'planId required')
  if (typeof notes !== 'string') {
    throw new HttpsError('invalid-argument', 'notes (string) required')
  }
  await saveUserNotes(uid, planId, notes)
  return { ok: true }
})

export const searchSongs = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { query } = req.data as { query?: string }
  if (!query) throw new HttpsError('invalid-argument', 'query required')
  const client = await pcoForUser(uid)
  const songs = await client.searchSongs(query)
  return { songs }
})

// To add another provider (openai, ...):
//   1. firebase functions:secrets:set <PROVIDER>_API_KEY
//   2. add the secret to secrets[] below and the imports
//   3. add a case to the switch
// Each secret listed in secrets[] must exist in Secret Manager at deploy
// time, so only bind providers whose keys you've actually set.
export const suggestSongs = onCall(
  { secrets: [ANTHROPIC_API_KEY, GEMINI_API_KEY] },
  async (req) => {
    const { uid } = requireAllowed(req)
    const {
      theme,
      userMessage,
      exclude,
      count,
      planId,
      serviceOrder,
      planNotes,
      history,
      shortlistedTitles,
      rejectedTitles,
    } = req.data as {
      theme?: string
      userMessage?: string
      exclude?: string[]
      count?: number
      planId?: string
      serviceOrder?: string
      planNotes?: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
      shortlistedTitles?: string[]
      rejectedTitles?: string[]
    }
    if (!theme) throw new HttpsError('invalid-argument', 'theme required')

    const provider = AI_PROVIDER.value()
    let apiKey: string
    switch (provider) {
      case 'anthropic':
        apiKey = ANTHROPIC_API_KEY.value()
        break
      case 'gemini':
        apiKey = GEMINI_API_KEY.value()
        break
      default:
        throw new HttpsError(
          'failed-precondition',
          `Provider "${provider}" not wired. Bind its secret in suggestSongs and add a case here.`,
        )
    }

    const [structure, role] = await Promise.all([
      loadResolved(uid, 'structure', planId),
      loadResolved(uid, 'role', planId),
    ])

    const ai = getAiProvider(provider, apiKey)
    const result = await ai.suggestSongs({
      theme,
      userMessage: userMessage ?? '',
      structurePrompt: structure.effective.value,
      systemPrompt: composeSystemPrompt(role.effective.value),
      serviceOrder,
      planNotes,
      shortlistedTitles,
      rejectedTitles,
      history,
      exclude,
      count,
    })
    return {
      suggestions: result.suggestions,
      debug: result.debug,
      assistantMessage: result.assistantMessage,
      provider,
      structureSource: structure.effective.source,
      roleSource: role.effective.source,
    }
  },
)

function parseType(raw: unknown): PromptType {
  if (raw === 'structure' || raw === 'role') return raw
  throw new HttpsError('invalid-argument', 'type must be "structure" or "role"')
}

export const getPromptConfig = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { type: rawType, planId } = req.data as { type?: unknown; planId?: string }
  const type = parseType(rawType)
  return await loadResolved(uid, type, planId)
})

export const savePromptConfig = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const {
    type: rawType,
    scope,
    planId,
    value,
  } = req.data as {
    type?: unknown
    scope?: 'default' | 'plan'
    planId?: string
    value?: string
  }
  const type = parseType(rawType)
  if (scope !== 'default' && scope !== 'plan') {
    throw new HttpsError('invalid-argument', 'scope must be "default" or "plan"')
  }
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', 'value (string) required')
  }
  if (scope === 'default') {
    await saveUserDefault(uid, type, value)
  } else {
    if (!planId) throw new HttpsError('invalid-argument', 'planId required for scope "plan"')
    if (value.trim()) {
      await savePlanOverride(uid, type, planId, value)
    } else {
      await clearPlanOverride(uid, type, planId)
    }
  }
  return { ok: true, builtIn: hardcodedDefaultFor(type) }
})

export const getAdminStatus = onCall(async (req) => {
  const { email } = requireAllowed(req)
  return { isAdmin: isAdminEmail(email) }
})

export const getAdminPromptConfig = onCall(async (req) => {
  requireAdmin(req)
  const admin = await loadAdminDefaults()
  return {
    structure: {
      admin: admin.structure,
      hardcoded: hardcodedDefaultFor('structure'),
    },
    role: {
      admin: admin.role,
      hardcoded: hardcodedDefaultFor('role'),
    },
    technical: TECHNICAL_REQUIREMENTS,
  }
})

export const saveAdminPromptConfig = onCall(async (req) => {
  requireAdmin(req)
  const { type: rawType, value } = req.data as { type?: unknown; value?: unknown }
  const type = parseType(rawType)
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', 'value (string) required')
  }
  await saveAdminDefault(type, value)
  return { ok: true }
})

export const loadSession = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { planId } = req.data as { planId?: string }
  if (!planId) throw new HttpsError('invalid-argument', 'planId required')
  return await loadPickerSession(uid, planId)
})

export const saveSession = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { planId, session } = req.data as {
    planId?: string
    session?: PickerSession
  }
  if (!planId) throw new HttpsError('invalid-argument', 'planId required')
  if (!session) throw new HttpsError('invalid-argument', 'session required')
  await savePickerSession(uid, planId, session)
  return { ok: true }
})

export const commitSlot = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { serviceTypeId, planId, itemId, songId } = req.data as {
    serviceTypeId?: string
    planId?: string
    itemId?: string
    songId?: string
  }
  if (!serviceTypeId || !planId || !itemId || !songId) {
    throw new HttpsError(
      'invalid-argument',
      'serviceTypeId, planId, itemId, and songId required',
    )
  }
  const client = await pcoForUser(uid)
  await client.updatePlanItem(serviceTypeId, planId, itemId, { songId })
  return { ok: true }
})

export const commitPlanItems = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { serviceTypeId, planId, items } = req.data as {
    serviceTypeId?: string
    planId?: string
    items?: NewItem[]
  }
  if (!serviceTypeId || !planId || !items?.length) {
    throw new HttpsError(
      'invalid-argument',
      'serviceTypeId, planId, and non-empty items required',
    )
  }
  const client = await pcoForUser(uid)
  let created = 0
  for (const item of items) {
    await client.createPlanItem(serviceTypeId, planId, item)
    created += 1
  }
  return { created }
})
