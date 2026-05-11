import { initializeApp } from 'firebase-admin/app'
import { setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'

import { getAiProvider } from './ai'
import { PcoClient } from './pco/client'
import {
  hasPcoCredentials,
  pcoForUser,
  savePcoCredentialsForUser,
} from './pco/credentials'
import { countSongs } from './pco/songSlots'
import type { NewItem } from './pco/types'
import {
  AI_PROVIDER,
  ALLOWED_EMAIL,
  ANTHROPIC_API_KEY,
  GEMINI_API_KEY,
  INCLUDED_SERVICE_TYPES,
} from './config'

initializeApp()
setGlobalOptions({ region: 'us-central1', maxInstances: 10 })

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
  const plans = await Promise.all(
    filtered.map(async (p) => {
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
    }),
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
  const [plan, notes, items] = await Promise.all([
    client.getPlan(serviceTypeId, planId),
    client.getPlanNotes(serviceTypeId, planId),
    client.listPlanItems(serviceTypeId, planId),
  ])
  return { plan, notes, items }
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
    requireAllowed(req)
    const { theme, criteria, exclude, count } = req.data as {
      theme?: string
      criteria?: string
      exclude?: string[]
      count?: number
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
    const ai = getAiProvider(provider, apiKey)
    const suggestions = await ai.suggestSongs({
      theme,
      criteria: criteria ?? '',
      exclude,
      count,
    })
    return { suggestions, provider }
  },
)

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
