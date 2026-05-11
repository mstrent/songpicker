import { initializeApp } from 'firebase-admin/app'
import { setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'

import { getAiProvider } from './ai'
import { PcoClient } from './pco/client'
import type { NewItem } from './pco/types'
import {
  AI_PROVIDER,
  ALLOWED_EMAIL,
  ANTHROPIC_API_KEY,
  GEMINI_API_KEY,
  INCLUDED_SERVICE_TYPES,
  PCO_APP_ID,
  PCO_SECRET,
} from './config'

initializeApp()
setGlobalOptions({ region: 'us-central1', maxInstances: 10 })

function requireAllowed(req: CallableRequest<unknown>): string {
  const email = req.auth?.token?.email
  if (!email) throw new HttpsError('unauthenticated', 'Sign in required')
  const allowed = ALLOWED_EMAIL.value()
  if (allowed && email !== allowed) {
    throw new HttpsError('permission-denied', `Not authorized: ${email}`)
  }
  return email
}

function pco(): PcoClient {
  return new PcoClient(PCO_APP_ID.value(), PCO_SECRET.value())
}

export const listPlans = onCall(
  { secrets: [PCO_APP_ID, PCO_SECRET] },
  async (req) => {
    requireAllowed(req)
    const allowed = INCLUDED_SERVICE_TYPES.value()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const client = pco()
    const all = await client.listAllUpcomingPlans()
    const filtered = allowed.length
      ? all.filter((p) => p.serviceTypeName != null && allowed.includes(p.serviceTypeName))
      : all

    // Enrich each plan with everyone on its roster (name + email + position
    // + team) so the SPA can do both the "led by …" display and the
    // "you're serving / leading" highlight without further server calls.
    // Parallel fetch keeps total latency ~one PCO round-trip even with N
    // plans; per-plan failures are swallowed so one bad plan doesn't blank
    // the whole list.
    const plans = await Promise.all(
      filtered.map(async (p) => {
        try {
          const people = await client.listPlanPeople(p.serviceTypeId, p.id)
          const teamMembers = people
            .filter((pp) => pp.status !== 'D')
            .filter((pp): pp is typeof pp & { name: string } => !!pp.name)
            .map((pp) => ({
              name: pp.name,
              email: pp.email,
              position: pp.position,
              team: pp.team,
            }))
          return { ...p, teamMembers }
        } catch {
          return p
        }
      }),
    )
    return { plans }
  },
)

export const getPlanContext = onCall(
  { secrets: [PCO_APP_ID, PCO_SECRET] },
  async (req) => {
    requireAllowed(req)
    const { serviceTypeId, planId } = req.data as {
      serviceTypeId?: string
      planId?: string
    }
    if (!serviceTypeId || !planId) {
      throw new HttpsError('invalid-argument', 'serviceTypeId and planId required')
    }
    const client = pco()
    const [plan, notes, items] = await Promise.all([
      client.getPlan(serviceTypeId, planId),
      client.getPlanNotes(serviceTypeId, planId),
      client.listPlanItems(serviceTypeId, planId),
    ])
    return { plan, notes, items }
  },
)

export const searchSongs = onCall(
  { secrets: [PCO_APP_ID, PCO_SECRET] },
  async (req) => {
    requireAllowed(req)
    const { query } = req.data as { query?: string }
    if (!query) throw new HttpsError('invalid-argument', 'query required')
    const songs = await pco().searchSongs(query)
    return { songs }
  },
)

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

export const commitPlanItems = onCall(
  { secrets: [PCO_APP_ID, PCO_SECRET] },
  async (req) => {
    requireAllowed(req)
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
    const client = pco()
    let created = 0
    for (const item of items) {
      await client.createPlanItem(serviceTypeId, planId, item)
      created += 1
    }
    return { created }
  },
)
