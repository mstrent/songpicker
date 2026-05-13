import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

interface EmptyStateProps {
  icon?: IconName
  title: string
  body?: ReactNode
  className?: string
}

// Soft, friendly empty-state block used wherever a list or column
// renders nothing. Single large icon up top, a one-line heading, and
// an optional supporting line. Pinned to the surface palette so it
// reads as a "nothing here yet" card, not an error.
export function EmptyState({
  icon = 'sparkle',
  title,
  body,
  className,
}: EmptyStateProps) {
  return (
    <div className={`empty-state${className ? ` ${className}` : ''}`}>
      <div className="empty-state-icon" aria-hidden>
        <Icon name={icon} size={28} />
      </div>
      <div className="empty-state-title">{title}</div>
      {body && <div className="empty-state-body">{body}</div>}
    </div>
  )
}
