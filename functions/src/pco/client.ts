import type {
  NewItem,
  Plan,
  PlanItem,
  PlanNote,
  PlanPerson,
  ServiceType,
  Song,
} from './types'

const BASE_URL = 'https://api.planningcenteronline.com/services/v2'

interface JsonApiRef {
  id: string
  type: string
}

interface JsonApiResource<A = Record<string, unknown>> {
  id: string
  type: string
  attributes: A
  relationships?: Record<string, { data?: JsonApiRef | JsonApiRef[] | null }>
}

interface JsonApiResponse<A = Record<string, unknown>> {
  data: JsonApiResource<A> | JsonApiResource<A>[]
  included?: JsonApiResource[]
}

function firstRefId(
  rel: { data?: JsonApiRef | JsonApiRef[] | null } | undefined,
): string | null {
  const d = rel?.data
  if (!d) return null
  return Array.isArray(d) ? (d[0]?.id ?? null) : d.id
}

export class PcoClient {
  constructor(
    private readonly appId: string,
    private readonly secret: string,
  ) {}

  private headers(): Record<string, string> {
    const auth = Buffer.from(`${this.appId}:${this.secret}`).toString('base64')
    return {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  private async fetch<T = JsonApiResponse>(
    path: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<T> {
    const url = `${BASE_URL}${path}`
    const reqInit = {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    }
    let res = await fetch(url, reqInit)
    if (res.status === 429) {
      // PCO returns "Retry-After" in seconds (its rate window is 20s).
      // Wait, then retry once. If still rate-limited, let the error bubble.
      const retryAfterRaw = res.headers.get('Retry-After')
      const waitSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : 20
      const waitMs = Math.min(Math.max(waitSec * 1000, 1000), 30000)
      await new Promise((r) => setTimeout(r, waitMs))
      res = await fetch(url, reqInit)
    }
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Planning Center ${res.status} ${path}: ${body.slice(0, 500)}`)
    }
    return res.json() as Promise<T>
  }

  async listServiceTypes(): Promise<ServiceType[]> {
    const json = await this.fetch<JsonApiResponse<{ name: string | null }>>(
      '/service_types?per_page=100',
    )
    const data = Array.isArray(json.data) ? json.data : [json.data]
    return data.map((d) => ({ id: d.id, name: d.attributes.name }))
  }

  async listPlans(
    serviceType: ServiceType,
    opts: { filter?: 'future' | 'past'; perPage?: number; order?: string } = {},
  ): Promise<Plan[]> {
    const params = new URLSearchParams()
    if (opts.filter) params.set('filter', opts.filter)
    params.set('per_page', String(opts.perPage ?? 10))
    params.set('order', opts.order ?? 'sort_date')

    const json = await this.fetch<
      JsonApiResponse<{
        title: string | null
        series_title: string | null
        sort_date: string | null
      }>
    >(`/service_types/${serviceType.id}/plans?${params}`)

    const data = Array.isArray(json.data) ? json.data : [json.data]
    return data.map((d) => ({
      id: d.id,
      serviceTypeId: serviceType.id,
      serviceTypeName: serviceType.name,
      title: d.attributes.title,
      seriesTitle: d.attributes.series_title,
      sortDate: d.attributes.sort_date,
    }))
  }

  async listAllPlans(
    opts: { past?: number; future?: number } = {},
  ): Promise<Plan[]> {
    const types = await this.listServiceTypes()
    const future = opts.future ?? 10
    const past = opts.past ?? 0

    const futureFetches = types.map((t) =>
      this.listPlans(t, { filter: 'future', perPage: future, order: 'sort_date' }),
    )
    const pastFetches =
      past > 0
        ? types.map((t) =>
            this.listPlans(t, { filter: 'past', perPage: past, order: '-sort_date' }),
          )
        : []

    const [futureResults, pastResults] = await Promise.all([
      Promise.all(futureFetches),
      Promise.all(pastFetches),
    ])

    return [...pastResults.flat(), ...futureResults.flat()].sort((a, b) =>
      (a.sortDate ?? '').localeCompare(b.sortDate ?? ''),
    )
  }

  async getPlan(serviceTypeId: string, planId: string): Promise<Plan> {
    // No extra listServiceTypes here — serviceTypeName only matters in the
    // list view (where it comes from listPlans), and an extra call per
    // detail-page open costs a real chunk of our 100 req/20s budget.
    const json = await this.fetch<
      JsonApiResponse<{
        title: string | null
        series_title: string | null
        sort_date: string | null
      }>
    >(`/service_types/${serviceTypeId}/plans/${planId}`)
    const d = Array.isArray(json.data) ? json.data[0] : json.data
    return {
      id: d.id,
      serviceTypeId,
      serviceTypeName: null,
      title: d.attributes.title,
      seriesTitle: d.attributes.series_title,
      sortDate: d.attributes.sort_date,
    }
  }

  async listPlanPeople(serviceTypeId: string, planId: string): Promise<PlanPerson[]> {
    const json = await this.fetch<
      JsonApiResponse<{
        name: string | null
        team_position_name: string | null
        status: string | null
      }>
    >(
      `/service_types/${serviceTypeId}/plans/${planId}/team_members?include=person.emails,team&per_page=100`,
    )

    // Build email_id -> address lookup, preferring `primary` ones.
    const emailById = new Map<string, { address: string; primary: boolean }>()
    for (const inc of json.included ?? []) {
      if (inc.type === 'Email') {
        const a = inc.attributes as { address?: string; primary?: boolean }
        if (a.address) {
          emailById.set(inc.id, { address: a.address, primary: !!a.primary })
        }
      }
    }

    // Build person_id -> email (primary if any, else first).
    const personEmail = new Map<string, string>()
    for (const inc of json.included ?? []) {
      if (inc.type !== 'Person') continue
      const rel = inc.relationships?.emails?.data
      const refs = Array.isArray(rel) ? rel : rel ? [rel] : []
      const candidates = refs
        .map((r) => emailById.get(r.id))
        .filter((e): e is { address: string; primary: boolean } => !!e)
      const pick = candidates.find((c) => c.primary) ?? candidates[0]
      if (pick) personEmail.set(inc.id, pick.address.toLowerCase())
    }

    // Build team_id -> name lookup.
    const teamName = new Map<string, string>()
    for (const inc of json.included ?? []) {
      if (inc.type === 'Team') {
        const name = (inc.attributes as { name?: string }).name
        if (name) teamName.set(inc.id, name)
      }
    }

    const data = Array.isArray(json.data) ? json.data : [json.data]
    return data.map((d) => {
      const personId = firstRefId(d.relationships?.person)
      const teamId = firstRefId(d.relationships?.team)
      return {
        id: d.id,
        name: d.attributes.name,
        position: d.attributes.team_position_name,
        status: d.attributes.status,
        email: personId ? (personEmail.get(personId) ?? null) : null,
        team: teamId ? (teamName.get(teamId) ?? null) : null,
      }
    })
  }

  async listPlanItems(serviceTypeId: string, planId: string): Promise<PlanItem[]> {
    const json = await this.fetch<
      JsonApiResponse<{
        title: string | null
        item_type: string | null
        sequence: number | null
        key_name: string | null
        description: string | null
      }>
    >(
      `/service_types/${serviceTypeId}/plans/${planId}/items?include=song,item_notes,item_assignments,item_assignments.assignable&order=sequence&per_page=100`,
    )
    interface SongRef {
      title: string
      author: string | null
      ccli: string | null
    }
    const songsById = new Map<string, SongRef>()
    const noteContent = new Map<string, string>()
    // Two-pass over included so we can resolve ItemAssignment -> Person
    // (or TeamPosition) regardless of arrival order. Persons get their
    // display name from full_name; TeamPositions fall back to the
    // position name with a "(position)" marker.
    const personNames = new Map<string, string>()
    const teamPositionNames = new Map<string, string>()
    const assignmentTargets = new Map<
      string,
      { type: string; id: string }
    >()

    for (const inc of json.included ?? []) {
      if (inc.type === 'Song') {
        const a = inc.attributes as {
          title?: string
          author?: string | null
          ccli_number?: string | null
        }
        if (a.title) {
          songsById.set(inc.id, {
            title: a.title,
            author: a.author ?? null,
            ccli: a.ccli_number ?? null,
          })
        }
      } else if (inc.type === 'ItemNote') {
        const a = inc.attributes as { content?: string }
        if (a.content && a.content.trim()) {
          noteContent.set(inc.id, a.content.trim())
        }
      } else if (inc.type === 'Person') {
        const a = inc.attributes as {
          full_name?: string
          first_name?: string
          last_name?: string
          name?: string
        }
        const name =
          a.full_name ??
          a.name ??
          [a.first_name, a.last_name].filter(Boolean).join(' ').trim() ??
          null
        if (name) personNames.set(inc.id, name)
      } else if (inc.type === 'TeamPosition') {
        const name = (inc.attributes as { name?: string }).name
        if (name) teamPositionNames.set(inc.id, name)
      } else if (inc.type === 'ItemAssignment') {
        const assignable = inc.relationships?.assignable?.data
        const ref = Array.isArray(assignable) ? assignable[0] : assignable
        if (ref) assignmentTargets.set(inc.id, { type: ref.type, id: ref.id })
      }
    }

    const data = Array.isArray(json.data) ? json.data : [json.data]
    return data.map((d) => {
      const songId = firstRefId(d.relationships?.song)
      const noteRel = d.relationships?.item_notes?.data
      const noteRefs = Array.isArray(noteRel) ? noteRel : noteRel ? [noteRel] : []
      const notes = noteRefs
        .map((r) => noteContent.get(r.id))
        .filter((c): c is string => !!c)
        .map((content) => ({ content }))

      const assignRel = d.relationships?.item_assignments?.data
      const assignRefs = Array.isArray(assignRel)
        ? assignRel
        : assignRel
          ? [assignRel]
          : []
      const leaders = assignRefs
        .map((r) => assignmentTargets.get(r.id))
        .filter((t): t is { type: string; id: string } => !!t)
        .map((t) => {
          if (t.type === 'Person') return personNames.get(t.id) ?? null
          if (t.type === 'TeamPosition') {
            const pos = teamPositionNames.get(t.id)
            return pos ? `${pos} (position)` : null
          }
          return null
        })
        .filter((n): n is string => !!n)

      const description = d.attributes.description ?? null
      const songRef = songId ? songsById.get(songId) : undefined
      return {
        id: d.id,
        sequence: d.attributes.sequence ?? 0,
        title: d.attributes.title ?? '',
        itemType: d.attributes.item_type ?? 'item',
        songId,
        songTitle: songRef?.title ?? null,
        songAuthor: songRef?.author ?? null,
        songCcli: songRef?.ccli ?? null,
        keyName: d.attributes.key_name ?? null,
        description: description && description.trim() ? description.trim() : null,
        notes,
        leaders,
      }
    })
  }

  async getPlanNotes(serviceTypeId: string, planId: string): Promise<PlanNote[]> {
    const json = await this.fetch<JsonApiResponse<{ content: string }>>(
      `/service_types/${serviceTypeId}/plans/${planId}/notes?include=plan_note_category&per_page=100`,
    )
    const categories = new Map<string, string>()
    for (const inc of json.included ?? []) {
      if (inc.type === 'PlanNoteCategory') {
        const name = (inc.attributes as { name?: string }).name
        if (name) categories.set(inc.id, name)
      }
    }
    const data = Array.isArray(json.data) ? json.data : [json.data]
    return data.map((d) => {
      const catId = firstRefId(d.relationships?.plan_note_category)
      return {
        id: d.id,
        content: d.attributes.content,
        category: catId ? (categories.get(catId) ?? null) : null,
      }
    })
  }

  async searchSongs(query: string): Promise<Song[]> {
    // PCO's /songs endpoint silently ignores `q=` and `where[title_like]=`
    // (verified — both return the default-ordered library regardless of
    // input). Only `where[title]=` (case-insensitive exact match) actually
    // filters. Try the title verbatim, then again with parentheticals
    // stripped to handle AI suggestions like "How Great Is Our God (Hillsong)".
    const tryTitle = async (title: string): Promise<Song[]> => {
      const trimmed = title.trim()
      if (!trimmed) return []
      const params = new URLSearchParams({
        'where[title]': trimmed,
        per_page: '10',
      })
      const json = await this.fetch<
        JsonApiResponse<{
          title: string
          author: string | null
          ccli_number: string | null
          themes: string | null
          hidden: boolean
          last_scheduled_at: string | null
          last_scheduled_short_dates: string | null
        }>
      >(`/songs?${params}`)
      const data = Array.isArray(json.data) ? json.data : [json.data]
      return data.map((d) => ({
        id: d.id,
        title: d.attributes.title,
        author: d.attributes.author,
        ccliNumber: d.attributes.ccli_number,
        themes: d.attributes.themes,
        isHidden: d.attributes.hidden,
        lastScheduledAt: d.attributes.last_scheduled_at,
        lastScheduledShortDates: d.attributes.last_scheduled_short_dates,
      }))
    }

    const direct = await tryTitle(query)
    if (direct.length > 0) return direct

    const stripped = query.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
    if (stripped && stripped.toLowerCase() !== query.trim().toLowerCase()) {
      return tryTitle(stripped)
    }
    return []
  }

  async updatePlanItem(
    serviceTypeId: string,
    planId: string,
    itemId: string,
    opts: { songId?: string; arrangementId?: string; title?: string },
  ): Promise<void> {
    const data: Record<string, unknown> = {
      type: 'Item',
      id: itemId,
    }
    const relationships: Record<string, { data: { type: string; id: string } }> = {}
    if (opts.songId) relationships.song = { data: { type: 'Song', id: opts.songId } }
    if (opts.arrangementId) {
      relationships.arrangement = { data: { type: 'Arrangement', id: opts.arrangementId } }
    }
    if (Object.keys(relationships).length > 0) {
      data.relationships = relationships
    }
    if (opts.title !== undefined) {
      // PCO's web UI rewrites the item title to the song name when you
      // link a song, but its API leaves the title untouched. We push the
      // attribute change in the same PATCH so behavior matches.
      data.attributes = { title: opts.title }
    }
    const body = JSON.stringify({ data })
    await this.fetch(
      `/service_types/${serviceTypeId}/plans/${planId}/items/${itemId}`,
      { method: 'PATCH', body },
    )
  }

  // Unset both the song and arrangement relationships so the slot reverts
  // to "empty" in Planning Center. Used when the user wants to retry a
  // pick — clearing the slot lets the AI propose new options for that
  // role on the next Suggest call. When `title` is provided it's PATCHed
  // alongside the cleared relationships so the slot's title reverts (to
  // the title it had before the song was committed, or to a "Song N"
  // fallback computed by the caller).
  async clearPlanItemSong(
    serviceTypeId: string,
    planId: string,
    itemId: string,
    title?: string,
  ): Promise<void> {
    const data: Record<string, unknown> = {
      type: 'Item',
      id: itemId,
      relationships: {
        song: { data: null },
        arrangement: { data: null },
      },
    }
    if (title !== undefined) {
      data.attributes = { title }
    }
    const body = JSON.stringify({ data })
    await this.fetch(
      `/service_types/${serviceTypeId}/plans/${planId}/items/${itemId}`,
      { method: 'PATCH', body },
    )
  }

  async createPlanItem(
    serviceTypeId: string,
    planId: string,
    item: NewItem,
  ): Promise<{ id: string }> {
    const body = JSON.stringify({
      data: {
        type: 'Item',
        attributes: {
          title: item.title,
          sequence: item.sequence,
          item_type: item.itemType,
        },
        relationships: item.songId
          ? { song: { data: { type: 'Song', id: item.songId } } }
          : undefined,
      },
    })
    const json = await this.fetch<JsonApiResponse<Record<string, unknown>>>(
      `/service_types/${serviceTypeId}/plans/${planId}/items`,
      { method: 'POST', body },
    )
    const created = Array.isArray(json.data) ? json.data[0] : json.data
    return { id: created.id }
  }
}
