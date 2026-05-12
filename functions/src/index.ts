import { initializeApp } from 'firebase-admin/app'
import { setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'

import { getAiProvider } from './ai'
import type { AiCandidate, StreamChunk } from './ai/types'
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
  listRejectionReasons,
  publicShape as publicRejectionReasonsShape,
  recordRejectReason as recordRejectReasonInternal,
  removeCommonReason as removeCommonReasonInternal,
} from './rejectionReasons'
import {
  loadPickerSession,
  savePickerSession,
  type PickerSession,
} from './sessions'
import {
  ADMIN_EMAILS,
  ALLOWED_EMAIL,
  ANTHROPIC_API_KEY,
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

// Streaming callable: streams text deltas and tool actions as the AI
// produces them, and resolves with the full SuggestResult for callers
// that prefer the non-streaming shape (or for the final state the SPA
// wants regardless — debug payload, structure/role source).
export const suggestSongs = onCall<
  unknown,
  Promise<unknown>,
  StreamChunk
>(
  { secrets: [ANTHROPIC_API_KEY] },
  async (req, res) => {
    const { uid } = requireAllowed(req)
    const {
      theme,
      userMessage,
      planId,
      serviceOrder,
      planNotes,
      history,
      candidates,
      alreadyInPlan,
      autoRefresh,
    } = req.data as {
      theme?: string
      userMessage?: string
      planId?: string
      serviceOrder?: string
      planNotes?: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
      candidates?: AiCandidate[]
      alreadyInPlan?: string[]
      autoRefresh?: boolean
    }
    if (!theme) throw new HttpsError('invalid-argument', 'theme required')

    const [structure, role] = await Promise.all([
      loadResolved(uid, 'structure', planId),
      loadResolved(uid, 'role', planId),
    ])

    const ai = getAiProvider(ANTHROPIC_API_KEY.value())
    // sendChunk is a no-op when the client called the regular (non-
    // streaming) callable, per the firebase-functions docs — so we can
    // always pass the onChunk through without checking acceptsStreaming.
    const onChunk = res
      ? async (chunk: StreamChunk) => {
          await res.sendChunk(chunk)
        }
      : undefined
    const result = await ai.suggestSongs(
      {
        theme,
        userMessage: userMessage ?? '',
        structurePrompt: structure.effective.value,
        systemPrompt: composeSystemPrompt(role.effective.value),
        serviceOrder,
        planNotes,
        candidates,
        alreadyInPlan,
        history,
        autoRefresh,
      },
      onChunk,
    )
    return {
      actions: result.actions,
      message: result.message,
      debug: result.debug,
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

// Intent-shaped placement endpoint: "ensure this song ends up in this
// slot." Handles both fresh commits (no fromSlotItemId) and moves
// (fromSlotItemId provided — clears it first, since PCO has no
// atomic move). Looks up the song's default arrangement + key and
// commits those alongside the song id so the slot lands fully
// populated, mirroring what the PCO web UI does on song-pick.
export const placeSongInSlot = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const {
    serviceTypeId,
    planId,
    slotItemId,
    songId,
    songTitle,
    fromSlotItemId,
    fromSlotRestoreTitle,
  } = req.data as {
    serviceTypeId?: string
    planId?: string
    slotItemId?: string
    songId?: string
    songTitle?: string
    fromSlotItemId?: string
    fromSlotRestoreTitle?: string
  }
  if (!serviceTypeId || !planId || !slotItemId || !songId) {
    throw new HttpsError(
      'invalid-argument',
      'serviceTypeId, planId, slotItemId, and songId required',
    )
  }
  const client = await pcoForUser(uid)
  // Clear the old slot first if this is a move. Sequential so the
  // song isn't briefly in two places (which PCO doesn't allow
  // anyway). If this PATCH fails, the commit below never runs and
  // the song stays in its original slot.
  if (fromSlotItemId && fromSlotItemId !== slotItemId) {
    await client.clearPlanItemSong(
      serviceTypeId,
      planId,
      fromSlotItemId,
      fromSlotRestoreTitle,
    )
  }
  // Same arrangement+key lookup as the old commitSlot endpoint so
  // the slot lands fully populated (title, song, arrangement, key).
  // Failures here don't block the commit — the song relationship +
  // title still get set so the pick isn't lost.
  let arrangementId: string | undefined
  let keyId: string | undefined
  try {
    const info = await client.getSongDefaultArrangementInfo(songId)
    if (info) {
      arrangementId = info.arrangementId
      if (info.keyId) keyId = info.keyId
    }
  } catch (err) {
    console.warn(
      `[placeSongInSlot] arrangement lookup failed for song ${songId}; committing song + title only:`,
      err,
    )
  }
  await client.updatePlanItem(serviceTypeId, planId, slotItemId, {
    songId,
    ...(arrangementId ? { arrangementId } : {}),
    ...(keyId ? { keyId } : {}),
    ...(songTitle ? { title: songTitle } : {}),
  })
  return { ok: true }
})

// Intent-shaped clear endpoint: "this slot should be empty." Renames
// the older clearSlot for consistency with placeSongInSlot.
export const clearSongFromSlot = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { serviceTypeId, planId, slotItemId, restoreTitle } = req.data as {
    serviceTypeId?: string
    planId?: string
    slotItemId?: string
    restoreTitle?: string
  }
  if (!serviceTypeId || !planId || !slotItemId) {
    throw new HttpsError(
      'invalid-argument',
      'serviceTypeId, planId, and slotItemId required',
    )
  }
  const client = await pcoForUser(uid)
  await client.clearPlanItemSong(serviceTypeId, planId, slotItemId, restoreTitle)
  return { ok: true }
})

export const commitSlot = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { serviceTypeId, planId, itemId, songId, songTitle } = req.data as {
    serviceTypeId?: string
    planId?: string
    itemId?: string
    songId?: string
    songTitle?: string
  }
  if (!serviceTypeId || !planId || !itemId || !songId) {
    throw new HttpsError(
      'invalid-argument',
      'serviceTypeId, planId, itemId, and songId required',
    )
  }
  const client = await pcoForUser(uid)
  // Look up the song's default arrangement + key so the slot ends up
  // fully populated — title, song, arrangement, AND key — the way the
  // PCO web UI does it when a user picks a song. If the lookup fails
  // (network blip, unusual song with no arrangements) we still commit
  // the song relationship + title so the pick isn't lost; the user can
  // fix the arrangement/key manually in PCO.
  let arrangementId: string | undefined
  let keyId: string | undefined
  try {
    const info = await client.getSongDefaultArrangementInfo(songId)
    if (info) {
      arrangementId = info.arrangementId
      if (info.keyId) keyId = info.keyId
    }
  } catch (err) {
    console.warn(
      `[commitSlot] arrangement lookup failed for song ${songId}; committing song + title only:`,
      err,
    )
  }
  await client.updatePlanItem(serviceTypeId, planId, itemId, {
    songId,
    ...(arrangementId ? { arrangementId } : {}),
    ...(keyId ? { keyId } : {}),
    // Mirror PCO web UI: linking a song sets the item title to match.
    ...(songTitle ? { title: songTitle } : {}),
  })
  return { ok: true }
})

export const reorderItems = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { serviceTypeId, planId, orderedItemIds } = req.data as {
    serviceTypeId?: string
    planId?: string
    orderedItemIds?: string[]
  }
  if (
    !serviceTypeId ||
    !planId ||
    !Array.isArray(orderedItemIds) ||
    orderedItemIds.length === 0
  ) {
    throw new HttpsError(
      'invalid-argument',
      'serviceTypeId, planId, and non-empty orderedItemIds required',
    )
  }
  const client = await pcoForUser(uid)
  await client.reorderPlanItems(serviceTypeId, planId, orderedItemIds)
  return { ok: true }
})

export const listSongArrangements = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { songId } = req.data as { songId?: string }
  if (!songId) {
    throw new HttpsError('invalid-argument', 'songId required')
  }
  const client = await pcoForUser(uid)
  const arrangements = await client.listSongArrangements(songId)
  return { arrangements }
})

export const setSlotArrangementKey = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { serviceTypeId, planId, itemId, arrangementId, keyId } = req.data as {
    serviceTypeId?: string
    planId?: string
    itemId?: string
    arrangementId?: string
    keyId?: string | null
  }
  if (!serviceTypeId || !planId || !itemId || !arrangementId) {
    throw new HttpsError(
      'invalid-argument',
      'serviceTypeId, planId, itemId, and arrangementId required',
    )
  }
  const client = await pcoForUser(uid)
  await client.updatePlanItem(serviceTypeId, planId, itemId, {
    arrangementId,
    ...(keyId ? { keyId } : {}),
  })
  return { ok: true }
})

export const clearSlot = onCall(async (req) => {
  const { uid } = requireAllowed(req)
  const { serviceTypeId, planId, itemId, title } = req.data as {
    serviceTypeId?: string
    planId?: string
    itemId?: string
    title?: string
  }
  if (!serviceTypeId || !planId || !itemId) {
    throw new HttpsError(
      'invalid-argument',
      'serviceTypeId, planId, and itemId required',
    )
  }
  const client = await pcoForUser(uid)
  await client.clearPlanItemSong(serviceTypeId, planId, itemId, title)
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

// Reject-rationale chip pool. Single global list across all users; any
// authenticated allowed user can add/remove chips. The SPA surfaces
// these as one-tap reasons on rejected candidate cards.
export const getRejectionReasons = onCall(async (req) => {
  requireAllowed(req)
  const doc = await listRejectionReasons()
  return publicRejectionReasonsShape(doc)
})

// Bound the secret here too so the inline distillation path (when
// freeformSinceDistill crosses the threshold) can reach Claude.
export const recordRejectReason = onCall(
  { secrets: [ANTHROPIC_API_KEY] },
  async (req) => {
    requireAllowed(req)
    const { reason } = req.data as { reason?: string }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw new HttpsError('invalid-argument', 'reason (non-empty string) required')
    }
    // Best-effort: if the secret isn't actually wired the inline call
    // still records the reason and skips distillation silently.
    const apiKey = (() => {
      try {
        return ANTHROPIC_API_KEY.value()
      } catch {
        return null
      }
    })()
    const doc = await recordRejectReasonInternal(reason, apiKey)
    return publicRejectionReasonsShape(doc)
  },
)

export const removeCommonReason = onCall(async (req) => {
  requireAllowed(req)
  const { text } = req.data as { text?: string }
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new HttpsError('invalid-argument', 'text (non-empty string) required')
  }
  await removeCommonReasonInternal(text)
  const doc = await listRejectionReasons()
  return publicRejectionReasonsShape(doc)
})
