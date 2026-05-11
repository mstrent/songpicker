import type { PromptConfigHookResult } from '../lib/usePromptConfig'

interface Props {
  label: string
  help: string
  hook: PromptConfigHookResult
}

export function PromptBody({ label, help, hook }: Props) {
  if (!hook.config) {
    return <div className="prompt-body">Loading…</div>
  }
  const { draft, setDraft, save, resetPlanOverride, saving, error, dirty, hasPlanOverride } =
    hook
  return (
    <div className="prompt-body" aria-label={label}>
      <p className="help">{help}</p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        disabled={!!saving}
      />
      <div className="actions">
        <button
          type="button"
          onClick={() => save('plan')}
          disabled={!!saving || !dirty}
          title="Use this prompt for this specific plan only"
        >
          {saving === 'plan' ? 'Saving…' : 'Save for this plan'}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => save('default')}
          disabled={!!saving || !dirty}
          title="Use this prompt for any plan that doesn't have its own override"
        >
          {saving === 'default' ? 'Saving…' : 'Save as my default'}
        </button>
        {hasPlanOverride && (
          <button
            type="button"
            className="ghost danger"
            onClick={resetPlanOverride}
            disabled={!!saving}
            title="Remove this plan's override and fall back to your default"
          >
            {saving === 'reset' ? 'Resetting…' : 'Reset this plan'}
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  )
}
