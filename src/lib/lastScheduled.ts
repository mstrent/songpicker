// Display helpers for a song's `lastScheduledAt` field from Planning
// Center. PCO returns the song's most recently *scheduled* date —
// which includes future plans. A song queued up on next Sunday's plan
// comes back with a future timestamp, so the chip can't just say
// "last played X ago" without checking which side of today the date
// falls on.

export type LastScheduledDisplay =
  | {
      kind: 'past'
      label: string // "last played 2 days ago"
      tooltip: string
      recent: boolean // within RECENT_DAYS — flag for chip-recent styling
    }
  | {
      kind: 'future'
      label: string // "scheduled 6/3"
      tooltip: string
      recent: boolean // within RECENT_DAYS of today — same congregation-notice signal
    }

// Within this many days (past or future), the congregation is
// likely to notice if the song is repeated/already-coming. Same
// threshold in both directions.
const RECENT_DAYS = 28

export function lastScheduledDisplay(iso: string): LastScheduledDisplay | null {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const now = Date.now()
  const diffDays = Math.floor((now - t) / (1000 * 60 * 60 * 24))
  const recent = Math.abs(diffDays) < RECENT_DAYS

  if (t > now) {
    return {
      kind: 'future',
      label: `scheduled ${shortDate(t)}`,
      tooltip: `Scheduled for ${new Date(t).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })} — already on an upcoming plan`,
      recent,
    }
  }
  return {
    kind: 'past',
    label: `last played ${pastRelative(diffDays)}`,
    tooltip: recent
      ? `Played ${pastRelative(diffDays)} — recent enough that congregations may notice if you repeat it`
      : new Date(t).toLocaleString(),
    recent,
  }
}

function shortDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function pastRelative(days: number): string {
  if (days < 1) return 'today'
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  if (days < 365) return `${Math.floor(days / 30)} months ago`
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? '' : 's'} ago`
}
