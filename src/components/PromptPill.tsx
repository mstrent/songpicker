import type { PromptSource, PromptType } from '../lib/api'

interface Props {
  type: PromptType
  label: string
  source: PromptSource
  isOpen: boolean
  onToggle: () => void
}

function sourceLabel(source: PromptSource): string {
  switch (source) {
    case 'plan':
      return 'this plan'
    case 'user':
      return 'yours'
    case 'system':
      return 'default'
  }
}

function sourceTooltip(source: PromptSource): string {
  switch (source) {
    case 'plan':
      return 'Using this plan’s override'
    case 'user':
      return 'Using your saved default'
    case 'system':
      return 'Using the built-in default'
  }
}

export function PromptPill({ label, source, isOpen, onToggle }: Props) {
  return (
    <button
      type="button"
      className={`prompt-pill${isOpen ? ' is-open' : ''}`}
      onClick={onToggle}
      aria-expanded={isOpen}
    >
      <span className="chevron" aria-hidden>▸</span>
      <span className="sparkle" aria-hidden>✨</span>
      <span className="gradient-text">{label}</span>
      <span className="source-tag" title={sourceTooltip(source)}>
        {sourceLabel(source)}
      </span>
    </button>
  )
}
