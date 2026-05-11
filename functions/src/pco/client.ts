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
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`PCO ${res.status} ${path}: ${body.slice(0, 500)}`)
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
    const [json, types] = await Promise.all([
      this.fetch<
        JsonApiResponse<{
          title: string | null
          series_title: string | null
          sort_date: string | null
        }>
      >(`/service_types/${serviceTypeId}/plans/${planId}`),
      this.listServiceTypes(),
    ])
    const d = Array.isArray(json.data) ? json.data[0] : json.data
    return {
      id: d.id,
      serviceTypeId,
      serviceTypeName: types.find((t) => t.id === serviceTypeId)?.name ?? null,
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
      }>
    >(
      `/service_types/${serviceTypeId}/plans/${planId}/items?include=song&order=sequence&per_page=100`,
    )
    const songTitles = new Map<string, string>()
    for (const inc of json.included ?? []) {
      if (inc.type === 'Song') {
        const title = (inc.attributes as { title?: string }).title
        if (title) songTitles.set(inc.id, title)
      }
    }
    const data = Array.isArray(json.data) ? json.data : [json.data]
    return data.map((d) => {
      const songId = firstRefId(d.relationships?.song)
      return {
        id: d.id,
        sequence: d.attributes.sequence ?? 0,
        title: d.attributes.title ?? '',
        itemType: d.attributes.item_type ?? 'item',
        songId,
        songTitle: songId ? (songTitles.get(songId) ?? null) : null,
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
