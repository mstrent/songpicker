import { signIn } from '../lib/auth'
import { Icon } from './Icon'

export function SignIn() {
  return (
    <div className="signin">
      <div className="signin-aura" aria-hidden />
      <div className="signin-content">
        <div className="signin-wordmark">
          <span className="signin-spark signin-spark-l" aria-hidden>
            ✦
          </span>
          <h1 className="signin-title">
            song<span className="accent">picker</span>
          </h1>
          <span className="signin-spark signin-spark-r" aria-hidden>
            ✦
          </span>
        </div>
        <p className="signin-tagline">
          <span className="sparkle" aria-hidden>
            ✨
          </span>
          AI-powered song suggestions for your Planning Center services
        </p>
        <button
          type="button"
          className="signin-btn"
          onClick={() => signIn().catch((e) => console.error(e))}
        >
          <Icon name="sparkle" size={16} />
          Sign in with Google
        </button>
        <p className="signin-foot">
          Uses your Google account to sign in. We never see your password.
        </p>
      </div>
    </div>
  )
}
