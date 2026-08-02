import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'

import {
  addAccessEntry as addAccessEntryInternal,
  emailMatchesEntries,
  entryIsValid,
  getAccess,
  removeAccessEntry as removeAccessEntryInternal,
  type AccessList,
} from './access'
import { getAiProvider } from './ai'
import {
  CLASSIFY_SONG_SYSTEM,
  CLASSIFY_SONG_TOOL,
  TOOLS,
} from './ai/anthropic'
import { AUTO_REFRESH_NUDGE, buildSampleUserMessage } from './ai/userMessage'
import type { AiCandidate, StreamChunk } from './ai/types'
import {
  defaultEnrichDeps,
  defaultLyricsDeps,
  enrichSnippetsBatch,
  getLyricsForSong,
} from './lyrics'
import { loadAllMetrics, recordMetric } from './metrics'
import { PcoClient } from './pco/client'
import { pMap } from './pco/concurrency'
import {
  hasPcoCredentials,
  pcoForUser,
  savePcoCredentialsForUser,
} from './pco/credentials'
import { countSongs } from './pco/songSlots'
import { formatRecentlySung, loadRecentSongs } from './recentSongs'
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
import { syncSlotPlaceholders } from './slotPlaceholders'
import {
  ADMIN_EMAILS,
  ALLOWED_EMAIL,
  ANTHROPIC_API_KEY,
  INCLUDED_SERVICE_TYPES,
} from './config'

initializeApp()
setGlobalOptions({ region: 'us-central1', maxInstances: 10 })

// Parse a comma-separated env value into validated allowlist entries.
// Entries are either exact emails ("matt@thetrents.org") or domain
// wildcards starting with "@" ("@thetrents.org").
function parseEnvEntries(envValue: string): string[] {
  return envValue
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => entryIsValid(s))
}

// Resolved entry list = env (break-glass root, immutable from UI) ∪
// Firestore-stored entries (managed via the Admin UI). Caching of the
// Firestore read happens inside getAccess().
async function resolveEntries(list: AccessList): Promise<string[]> {
  const env =
    list === 'allowed'
      ? parseEnvEntries(ALLOWED_EMAIL.value())
      : parseEnvEntries(ADMIN_EMAILS.value())
  const stored = await getAccess()
  const storedEntries =
    list === 'allowed' ? stored.allowedEmails : stored.adminEmails
  // Dedupe in case an entry exists in both. Order doesn't matter for matching.
  return Array.from(new Set([...env, ...storedEntries]))
}

async function isAdminEmail(email: string): Promise<boolean> {
  return emailMatchesEntries(await resolveEntries('admin'), email)
}

async function requireAdmin(
  req: CallableRequest<unknown>,
): Promise<{ uid: string; email: string }> {
  const auth = await requireAllowed(req)
  if (!(await isAdminEmail(auth.email))) {
    throw new HttpsError('permission-denied', 'Admin only')
  }
  return auth
}

async function requireAllowed(
  req: CallableRequest<unknown>,
): Promise<{ uid: string; email: string }> {
  const email = req.auth?.token?.email
  const uid = req.auth?.uid
  if (!email || !uid) throw new HttpsError('unauthenticated', 'Sign in required')
  // Fail closed: empty union → no match → denied. Missing env var +
  // empty Firestore doc can't silently open the gate.
  if (!emailMatchesEntries(await resolveEntries('allowed'), email)) {
    throw new HttpsError('permission-denied', `Not authorized: ${email}`)
  }
  return { uid, email }
}

// Returns whether the calling user has saved their PCO PAT. SPA uses this
// to decide whether to show the setup screen or the main app.
export const getPcoStatus = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
  return { hasCredentials: await hasPcoCredentials(uid) }
})

// Validate that the supplied PCO PAT works by hitting /service_types, then
// store it in Firestore. Bad creds bubble back to the SPA so the user
// retries instead of silently saving a wrong key.
export const savePcoCredentials = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
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
  const { uid } = await requireAllowed(req)
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
  const { uid, email } = await requireAllowed(req)
  void recordMetric(uid, email, 'plansOpened')
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
  // Reconcile persisted slot placeholders with current PCO state. The
  // sync only writes to Firestore when an empty slot's title diverged
  // from what we'd captured (or is brand new), so most loads are no-
  // ops. Returned to the SPA in the same response so the clear paths
  // can use a real placeholder rather than falling back to "Song N"
  // for slots that were filled before songpicker first observed them.
  const slotPlaceholders = await syncSlotPlaceholders(uid, planId, items)
  return { plan, notes, items, userTheme, userNotes, slotPlaceholders }
})

// Lean refresh used after slot-state writes — same items +
// slotPlaceholders shape that `getPlanContext` returns, but skips
// the plan + notes + userTheme + userNotes fetches (none of those
// change on a slot write). Reduces PCO chatter on the hot path.
// Plan-switch + initial load still use the full getPlanContext.
export const refreshSlotState = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
  const { serviceTypeId, planId } = req.data as {
    serviceTypeId?: string
    planId?: string
  }
  if (!serviceTypeId || !planId) {
    throw new HttpsError('invalid-argument', 'serviceTypeId and planId required')
  }
  const client = await pcoForUser(uid)
  const items = await client.listPlanItems(serviceTypeId, planId)
  const slotPlaceholders = await syncSlotPlaceholders(uid, planId, items)
  return { items, slotPlaceholders }
})

export const savePlanTheme = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
  const { planId, theme } = req.data as { planId?: string; theme?: string }
  if (!planId) throw new HttpsError('invalid-argument', 'planId required')
  if (typeof theme !== 'string') {
    throw new HttpsError('invalid-argument', 'theme (string) required')
  }
  await saveUserTheme(uid, planId, theme)
  return { ok: true }
})

export const savePlanNotes = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
  const { planId, notes } = req.data as { planId?: string; notes?: string }
  if (!planId) throw new HttpsError('invalid-argument', 'planId required')
  if (typeof notes !== 'string') {
    throw new HttpsError('invalid-argument', 'notes (string) required')
  }
  await saveUserNotes(uid, planId, notes)
  return { ok: true }
})

export const searchSongs = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
  const { query, author } = req.data as { query?: string; author?: string }
  if (!query) throw new HttpsError('invalid-argument', 'query required')
  const client = await pcoForUser(uid)
  const songs = await client.searchSongs(
    query,
    typeof author === 'string' && author.trim() ? { author: author.trim() } : {},
  )
  return { songs }
})

// Single-song fetch by PCO id. Used by the SPA when a song gets
// evicted from the plan and minted as a candidate — PlanItem doesn't
// carry lastScheduledAt, so the candidate card would otherwise lie
// about "never played." One direct PCO GET, no fuzzy matching.
export const getSong = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
  const { songId } = req.data as { songId?: string }
  if (!songId || typeof songId !== 'string') {
    throw new HttpsError('invalid-argument', 'songId required')
  }
  const client = await pcoForUser(uid)
  const song = await client.getSongById(songId)
  return { song }
})

// Batched library lookup. AI propose actions can mint several
// candidates at once; sending one Cloud Function call instead of N
// halves the round-trip overhead. PCO requests fan out under the
// existing pMap concurrency cap (5 parallel; same rate-limit
// behaviour as the singular callable would have under burst).
//
// Empty/blank queries get a `null` result entry so the caller can
// pair results with input candidates by index.
export const searchSongsBatch = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
  const { queries } = req.data as {
    queries?: Array<{ query?: string; author?: string }>
  }
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new HttpsError('invalid-argument', 'queries (non-empty array) required')
  }
  const client = await pcoForUser(uid)
  const results = await pMap(queries, async (q) => {
    const query = typeof q.query === 'string' ? q.query.trim() : ''
    if (!query) return null
    const author =
      typeof q.author === 'string' && q.author.trim()
        ? { author: q.author.trim() }
        : {}
    return client.searchSongs(query, author)
  })
  return { results }
})

// On-demand lyrics lookup for the candidate-card / slot-row modal.
// Wraps LRCLIB behind a shared Firestore cache so each (title, author)
// is fetched at most once across all users. Negative results are
// cached too — the modal exposes a "Re-check LRCLIB" button that sets
// forceRefresh: true when the user wants to try again.
export const getLyrics = onCall(
  { secrets: [ANTHROPIC_API_KEY] },
  async (req) => {
    await requireAllowed(req)
    const { title, author, forceRefresh } = req.data as {
      title?: string
      author?: string
      forceRefresh?: boolean
    }
    if (!title || typeof title !== 'string') {
      throw new HttpsError('invalid-argument', 'title required')
    }
    const db = getFirestore()
    const result = await getLyricsForSong(
      {
        title: title.trim(),
        author:
          typeof author === 'string' && author.trim()
            ? author.trim()
            : undefined,
        forceRefresh: forceRefresh === true,
      },
      defaultLyricsDeps(db, ANTHROPIC_API_KEY.value()),
    )
    return result
  },
)

// Batched lyrics lookup for proactive slot-row enrichment. Shares the
// same Firestore cache as getLyrics — this is just a batch wrapper so
// the SPA can pre-fetch lyrics for all committed slot songs in one
// round-trip at plan load rather than on each individual popover open.
// No snippet extraction — only plainLyrics + artistName are returned.
export const batchGetLyrics = onCall(
  { secrets: [ANTHROPIC_API_KEY] },
  async (req) => {
    await requireAllowed(req)
    const { songs } = req.data as {
      songs?: Array<{ title?: string; author?: string }>
    }
    if (!Array.isArray(songs) || songs.length === 0) {
      throw new HttpsError('invalid-argument', 'songs array required')
    }
    if (songs.length > 20) {
      throw new HttpsError('invalid-argument', 'max 20 songs per batch')
    }
    const db = getFirestore()
    const deps = defaultLyricsDeps(db, ANTHROPIC_API_KEY.value())
    const results = await pMap(
      songs,
      async (s) => {
        const title = typeof s.title === 'string' ? s.title.trim() : ''
        if (!title) return null
        const result = await getLyricsForSong(
          {
            title,
            author:
              typeof s.author === 'string' && s.author.trim()
                ? s.author.trim()
                : undefined,
          },
          deps,
        )
        return {
          found: result.found,
          plainLyrics: result.plainLyrics,
          artistName: result.artistName,
        }
      },
    )
    return { results }
  },
)

export const enrichSnippets = onCall(
  {
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: 180,
    // One request per instance. The LRCLIB fan-out uses a module-
    // level semaphore to be polite to LRCLIB's free API; with the
    // default concurrency (80), multiple parallel candidate requests
    // share that semaphore and stack queue waits to 100+ seconds.
    // Forcing concurrency=1 makes the semaphore per-request (each
    // instance gets its own module scope) and lets Cloud Functions
    // auto-scale to handle parallel candidate enrichment.
    concurrency: 1,
    // Override the global maxInstances=10 — a single Suggest can
    // produce 12+ candidates that all enrich in parallel, and at
    // concurrency=1 each needs its own instance. 20 gives headroom
    // while still capping cost exposure.
    maxInstances: 20,
  },
  async (req) => {
    await requireAllowed(req)
    const { songs, forceRefresh } = req.data as {
      songs?: Array<{ title?: string; author?: string }>
      forceRefresh?: boolean
    }
    if (!Array.isArray(songs) || songs.length === 0) {
      throw new HttpsError('invalid-argument', 'songs array required')
    }
    if (songs.length > 20) {
      throw new HttpsError('invalid-argument', 'max 20 songs per batch')
    }
    const validated = songs
      .filter(
        (s): s is { title: string; author?: string } =>
          typeof s.title === 'string' && s.title.trim().length > 0,
      )
      .map((s) => ({
        title: s.title.trim(),
        author:
          typeof s.author === 'string' && s.author.trim()
            ? s.author.trim()
            : undefined,
      }))
    const db = getFirestore()
    const deps = defaultEnrichDeps(db, ANTHROPIC_API_KEY.value())
    const results = await enrichSnippetsBatch(validated, deps, {
      forceRefresh: forceRefresh === true,
    })
    return { results }
  },
)

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
    const { uid, email } = await requireAllowed(req)
    void recordMetric(uid, email, 'aiSuggestions')
    const {
      theme,
      userMessage,
      planId,
      serviceTypeId,
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
      serviceTypeId?: string
      serviceOrder?: string
      planNotes?: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
      candidates?: AiCandidate[]
      alreadyInPlan?: string[]
      autoRefresh?: boolean
    }
    if (!theme) throw new HttpsError('invalid-argument', 'theme required')

    // Rotation context is best-effort: loadRecentSongs swallows its own
    // failures and returns [], so a PCO hiccup degrades the suggestion
    // rather than failing the turn. Skipped entirely on auto-refresh,
    // which can't propose anything anyway.
    const [structure, role, recentSongs] = await Promise.all([
      loadResolved(uid, 'structure', planId),
      loadResolved(uid, 'role', planId),
      serviceTypeId && !autoRefresh
        ? pcoForUser(uid).then((pco) =>
            loadRecentSongs(uid, pco, serviceTypeId),
          )
        : Promise.resolve([]),
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
    try {
      const result = await ai.suggestSongs(
        {
          theme,
          userMessage: userMessage ?? '',
          structurePrompt: structure.effective.value,
          systemPrompt: composeSystemPrompt(role.effective.value),
          serviceOrder,
          planNotes,
          recentlySung: formatRecentlySung(recentSongs, new Date()),
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
        structureSource: structure.effective.source,
        roleSource: role.effective.source,
      }
    } catch (e) {
      // Surface AI errors as a clean HttpsError instead of letting
      // firebase-functions wrap them as "INTERNAL", which is what the
      // client sees and is useless to a user. The anthropic provider
      // already rewrites content-filter blocks into a friendly message;
      // anything else falls through with its raw message.
      const err = e as Error
      console.error('[suggestSongs] failed:', err)
      throw new HttpsError(
        'aborted',
        err.message || 'The AI request failed unexpectedly',
      )
    }
  },
)

// Ancillary AI call — classify a single song's best-fit slot labels.
// Used when a song is minted as a candidate via plan eviction (not
// via AI proposal), so the candidate card can show "opener" / "closer"
// chips alongside its library-match info. Resolves the structure
// prompt through the same tier as suggestSongs (per-plan → user →
// admin → hardcoded). Haiku-backed (see anthropic.ts).
export const classifySongSlots = onCall(
  { secrets: [ANTHROPIC_API_KEY] },
  async (req) => {
    const { uid } = await requireAllowed(req)
    const {
      planId,
      songTitle,
      songAuthor,
      songCcli,
      theme,
      planNotes,
      serviceOrder,
    } = req.data as {
      planId?: string
      songTitle?: string
      songAuthor?: string
      // PCO returns ccli_number as integer per docs and historically
      // values have leaked through as numbers despite our types
      // claiming string. Accept both shapes and coerce on the way in.
      songCcli?: string | number
      theme?: string
      planNotes?: string
      serviceOrder?: string
    }
    if (!songTitle || typeof songTitle !== 'string' || !songTitle.trim()) {
      throw new HttpsError('invalid-argument', 'songTitle required')
    }
    const songCcliStr =
      songCcli != null ? String(songCcli).trim() || undefined : undefined
    const structure = await loadResolved(uid, 'structure', planId)
    const ai = getAiProvider(ANTHROPIC_API_KEY.value())
    try {
      return await ai.classifySongSlots({
        songTitle: songTitle.trim(),
        songAuthor: songAuthor?.trim() || undefined,
        songCcli: songCcliStr,
        theme: theme?.trim() || undefined,
        planNotes: planNotes?.trim() || undefined,
        structurePrompt: structure.effective.value,
        serviceOrder: serviceOrder?.trim() || undefined,
      })
    } catch (e) {
      const err = e as Error
      console.error('[classifySongSlots] failed:', err)
      // Classifier failure shouldn't break the enrichment flow on the
      // client — surface as aborted with a useful message; the SPA
      // patches the candidate with the data it does have.
      throw new HttpsError(
        'aborted',
        err.message || 'Slot classification failed',
      )
    }
  },
)

function parseType(raw: unknown): PromptType {
  if (raw === 'structure' || raw === 'role') return raw
  throw new HttpsError('invalid-argument', 'type must be "structure" or "role"')
}

export const getPromptConfig = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
  const { type: rawType, planId } = req.data as { type?: unknown; planId?: string }
  const type = parseType(rawType)
  return await loadResolved(uid, type, planId)
})

export const savePromptConfig = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
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
  const { email } = await requireAllowed(req)
  return { isAdmin: await isAdminEmail(email) }
})

export const getAdminPromptConfig = onCall(async (req) => {
  await requireAdmin(req)
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
    tooling: {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        // Full JSON Schema for each tool's input — exposes the nested
        // field descriptions (SONG_SLOTS_FIELD, candidateId
        // descriptions, etc.) that the top-level
        // description listing doesn't show. Rendered as pretty JSON.
        inputSchema: t.input_schema,
      })),
      autoRefreshNudge: AUTO_REFRESH_NUDGE,
      classifier: {
        systemPrompt: CLASSIFY_SONG_SYSTEM,
        tool: {
          name: CLASSIFY_SONG_TOOL.name,
          description: CLASSIFY_SONG_TOOL.description ?? '',
          inputSchema: CLASSIFY_SONG_TOOL.input_schema,
        },
      },
      // Assembled system message admins-side preview: role + technical
      // requirements concatenated as the model receives them. Uses the
      // hardcoded role default; admins can substitute their own role
      // mentally by editing the persona editor above.
      composedSystemPromptPreview: composeSystemPrompt(hardcodedDefaultFor('role')),
      // Sample per-turn user message — built via the same
      // buildUserMessage path the suggester uses, with placeholder
      // dynamic values + one candidate per decision type so admins
      // can see the exact format the model receives every turn.
      sampleUserMessage: buildSampleUserMessage(),
    },
  }
})

export const saveAdminPromptConfig = onCall(async (req) => {
  await requireAdmin(req)
  const { type: rawType, value } = req.data as { type?: unknown; value?: unknown }
  const type = parseType(rawType)
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', 'value (string) required')
  }
  await saveAdminDefault(type, value)
  return { ok: true }
})

export const loadSession = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
  const { planId } = req.data as { planId?: string }
  if (!planId) throw new HttpsError('invalid-argument', 'planId required')
  return await loadPickerSession(uid, planId)
})

export const saveSession = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
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
  const { uid, email } = await requireAllowed(req)
  void recordMetric(uid, email, 'slotCommits')
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
  const { uid, email } = await requireAllowed(req)
  void recordMetric(uid, email, 'slotClears')
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

export const reorderItems = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
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
  const { uid } = await requireAllowed(req)
  const { songId } = req.data as { songId?: string }
  if (!songId) {
    throw new HttpsError('invalid-argument', 'songId required')
  }
  const client = await pcoForUser(uid)
  const arrangements = await client.listSongArrangements(songId)
  return { arrangements }
})

export const setSlotArrangementKey = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
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

export const commitPlanItems = onCall(async (req) => {
  const { uid } = await requireAllowed(req)
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

// Allowed/admin email management. Env-based entries are the break-glass
// root (read-only here); the Firestore lists are what the admin can
// edit at runtime. Final auth uses the union, so env entries always
// keep at least one operator able to log in.
export const getAccessConfig = onCall(async (req) => {
  await requireAdmin(req)
  const stored = await getAccess()
  return {
    env: {
      allowedEmails: parseEnvEntries(ALLOWED_EMAIL.value()),
      adminEmails: parseEnvEntries(ADMIN_EMAILS.value()),
    },
    stored: {
      allowedEmails: stored.allowedEmails,
      adminEmails: stored.adminEmails,
    },
  }
})

function parseAccessList(raw: unknown): AccessList {
  if (raw === 'allowed' || raw === 'admin') return raw
  throw new HttpsError('invalid-argument', 'list must be "allowed" or "admin"')
}

export const addAccessEntry = onCall(async (req) => {
  await requireAdmin(req)
  const { list, entry } = req.data as { list?: unknown; entry?: unknown }
  const which = parseAccessList(list)
  if (typeof entry !== 'string' || !entry.trim()) {
    throw new HttpsError('invalid-argument', 'entry (non-empty string) required')
  }
  try {
    const stored = await addAccessEntryInternal(which, entry)
    return { stored }
  } catch (e) {
    // entryIsValid failures surface as invalid-argument so the UI can
    // show the message inline instead of an INTERNAL toast.
    throw new HttpsError('invalid-argument', (e as Error).message)
  }
})

export const removeAccessEntry = onCall(async (req) => {
  await requireAdmin(req)
  const { list, entry } = req.data as { list?: unknown; entry?: unknown }
  const which = parseAccessList(list)
  if (typeof entry !== 'string' || !entry.trim()) {
    throw new HttpsError('invalid-argument', 'entry (non-empty string) required')
  }
  const stored = await removeAccessEntryInternal(which, entry)
  return { stored }
})

// Fired by the SPA on each Firebase Auth sign-in transition.
export const recordSignIn = onCall(async (req) => {
  const { uid, email } = await requireAllowed(req)
  await recordMetric(uid, email, 'signIns')
  return { ok: true }
})

export const getMetrics = onCall(async (req) => {
  await requireAdmin(req)
  const users = await loadAllMetrics()
  return { users }
})
