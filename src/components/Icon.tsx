import type { SVGProps } from 'react'

// Lucide-style hairline icons. Single component so callers stay tidy and
// the icon set is discoverable in one place. Stroke uses currentColor so
// they inherit text color and work in both themes.

export type IconName =
  | 'external-link'
  | 'search'
  | 'refresh'
  | 'x'
  | 'check'
  | 'plus'
  | 'alert-triangle'
  | 'sparkle'
  | 'music'
  | 'spotify'
  | 'youtube'
  | 'chevron-right'
  | 'chevron-down'
  | 'edit'
  | 'trash'
  | 'send'
  | 'settings'

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number | string
}

export function Icon({ name, size = 16, className, ...rest }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className: className ? `icon icon-${name} ${className}` : `icon icon-${name}`,
    ...rest,
  }
  switch (name) {
    case 'external-link':
      return (
        <svg {...common}>
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
          <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
        </svg>
      )
    case 'search':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      )
    case 'refresh':
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      )
    case 'x':
      return (
        <svg {...common}>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      )
    case 'check':
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      )
    case 'alert-triangle':
      return (
        <svg {...common}>
          <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      )
    case 'sparkle':
      return (
        <svg {...common}>
          <path d="M12 3 13.8 8.2 19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" />
          <path d="M19 17.5 19.6 19l1.4.5-1.4.5L19 21.5 18.4 20l-1.4-.5 1.4-.5Z" />
        </svg>
      )
    case 'music':
      return (
        <svg {...common}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      )
    case 'spotify':
      // Filled brand mark — flat circle with three sound waves. Renders
      // crisp at 14–18px and inherits color via fill="currentColor".
      return (
        <svg
          {...common}
          fill="currentColor"
          stroke="none"
          aria-hidden
          viewBox="0 0 24 24"
        >
          <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.6 14.4a.8.8 0 0 1-1.1.3c-3-1.8-6.8-2.2-11.3-1.2a.8.8 0 1 1-.4-1.5c4.9-1.1 9.1-.6 12.5 1.4.4.2.5.7.3 1Zm1.2-2.8a1 1 0 0 1-1.3.3c-3.5-2.1-8.7-2.7-12.8-1.5a1 1 0 1 1-.6-1.9c4.6-1.4 10.4-.7 14.4 1.8.5.3.6.9.3 1.3Zm.1-2.9C13.7 8.2 6.9 8 3.1 9.1a1.2 1.2 0 1 1-.7-2.3C7 5.4 14.4 5.7 19 8.4a1.2 1.2 0 1 1-1.1 2.1Z" />
        </svg>
      )
    case 'youtube':
      // Filled brand mark — rounded rectangle with the play triangle
      // knocked out via fill-rule="evenodd" so the icon inherits color
      // via fill="currentColor" the same way the Spotify mark does.
      return (
        <svg
          {...common}
          fill="currentColor"
          stroke="none"
          aria-hidden
          viewBox="0 0 24 24"
        >
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M21.6 7.2c-.2-1-1-1.8-2-2C17.7 5 12 5 12 5s-5.7 0-7.6.2c-1 .2-1.8 1-2 2C2.2 9 2.2 12 2.2 12s0 3 .2 4.8c.2 1 1 1.8 2 2 1.9.2 7.6.2 7.6.2s5.7 0 7.6-.2c1-.2 1.8-1 2-2 .2-1.8.2-4.8.2-4.8s0-3-.2-4.8ZM10 15.5v-7l6 3.5-6 3.5Z"
          />
        </svg>
      )
    case 'chevron-right':
      return (
        <svg {...common}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      )
    case 'chevron-down':
      return (
        <svg {...common}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      )
    case 'edit':
      return (
        <svg {...common}>
          <path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6" />
          <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
        </svg>
      )
    case 'trash':
      return (
        <svg {...common}>
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="m5 6 1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14" />
        </svg>
      )
    case 'send':
      return (
        <svg {...common}>
          <path d="M22 2 11 13" />
          <path d="m22 2-7 20-4-9-9-4Z" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )
  }
}
