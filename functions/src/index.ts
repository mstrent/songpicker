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
  OPENAI_API_KEY,
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
    const plans = await pco().listAllUpcomingPlans()
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
    const notes = await pco().getPlanNotes(serviceTypeId, planId)
    return { notes }
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

export const suggestSongs = onCall(
  { secrets: [ANTHROPIC_API_KEY, OPENAI_API_KEY] },
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
    const apiKey =
      provider === 'anthropic' ? ANTHROPIC_API_KEY.value() : OPENAI_API_KEY.value()
    if (!apiKey) {
      throw new HttpsError(
        'failed-precondition',
        `Missing API key for provider: ${provider}`,
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
