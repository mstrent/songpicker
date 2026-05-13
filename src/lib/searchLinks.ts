// External search URLs for surfacing alongside song info.

export function spotifySearchUrl(query: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(query)}`
}

export function youtubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
}

export function praiseChartsSearchUrl(query: string): string {
  return `https://www.praisecharts.com/search?q=${encodeURIComponent(query)}`
}
