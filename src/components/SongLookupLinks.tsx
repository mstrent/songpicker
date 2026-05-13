import { Icon } from './Icon'
import {
  praiseChartsSearchUrl,
  spotifySearchUrl,
  youtubeSearchUrl,
} from '../lib/searchLinks'

interface SongLookupLinksProps {
  query: string
  /** "sm" matches the 26px buttons used in tight rows like the
   *  service-order item-actions strip; default matches the 32px
   *  buttons on the candidate cards. */
  size?: 'default' | 'sm'
}

// Shared row of outbound search buttons (Spotify / YouTube /
// PraiseCharts) used both on AI candidate cards and on filled slots in
// the service order. Single source of truth for the provider list so
// adding/removing a provider only happens in one place.
export function SongLookupLinks({ query, size = 'default' }: SongLookupLinksProps) {
  const small = size === 'sm'
  const cls = `iconbtn${small ? ' iconbtn-sm' : ''}`
  const iconSize = small ? 14 : 16
  return (
    <>
      <a
        className={`${cls} iconbtn-spotify`}
        href={spotifySearchUrl(query)}
        target="_blank"
        rel="noopener noreferrer"
        title="Search Spotify"
        aria-label="Search Spotify"
        draggable={false}
      >
        <Icon name="spotify" size={iconSize} />
      </a>
      <a
        className={`${cls} iconbtn-youtube`}
        href={youtubeSearchUrl(query)}
        target="_blank"
        rel="noopener noreferrer"
        title="Search YouTube"
        aria-label="Search YouTube"
        draggable={false}
      >
        <Icon name="youtube" size={iconSize} />
      </a>
      <a
        className={`${cls} iconbtn-chart`}
        href={praiseChartsSearchUrl(query)}
        target="_blank"
        rel="noopener noreferrer"
        title="Search PraiseCharts for a chord chart"
        aria-label="Search PraiseCharts"
        draggable={false}
      >
        <Icon name="music" size={iconSize} />
      </a>
    </>
  )
}
