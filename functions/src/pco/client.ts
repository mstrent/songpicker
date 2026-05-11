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

interface JsonApiResource<A = Record<string, unknown>> {
  id: string
  type: string
  attributes: A
  relationships?: Record<string, { data?: { id: string; type: string } | null }>
}

interface JsonApiResponse<A = Record<string, unknown>> {
  data: JsonApiResource<A> | JsonApiResource<A>[]
  included?: JsonApiResource[]
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
    opts: { future?: boolean; perPage?: number } = {},
  ): Promise<Plan[]> {
    const params = new URLSearchParams()
    if (opts.future) params.set('filter', 'future')
    params.set('per_page', String(opts.perPage ?? 10))
    params.set('order', 'sort_date')

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

  async listAllUpcomingPlans(): Promise<Plan[]> {
    const types = await this.listServiceTypes()
    const all = await Promise.all(
      types.map((t) => this.listPlans(t, { future: true, perPage: 10 })),
    )
    return all.flat().sort((a, b) => (a.sortDate ?? '').localeCompare(b.sortDate ?? ''))
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
    >(`/service_types/${serviceTypeId}/plans/${planId}/team_members?per_page=100`)
    const data = Array.isArray(json.data) ? json.data : [json.data]
    return data.map((d) => ({
      id: d.id,
      name: d.attributes.name,
      position: d.attributes.team_position_name,
      status: d.attributes.status,
    }))
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
      const songId = d.relationships?.song?.data?.id ?? null
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
    return data.map((d) => ({
      id: d.id,
      content: d.attributes.content,
      category:
        categories.get(d.relationships?.plan_note_category?.data?.id ?? '') ?? null,
    }))
  }

  async searchSongs(query: string): Promise<Song[]> {
    // `q` is PCO's free-text search (matches title/author/themes loosely);
    // falls back to listing all songs if PCO ignores it for this endpoint.
    const params = new URLSearchParams({ q: query, per_page: '25' })
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
