import { signIn } from '../lib/auth'

export function SignIn() {
  return (
    <div className="centered">
      <h1>songpicker</h1>
      <p>Sign in with your Google account to continue.</p>
      <button onClick={() => signIn().catch((e) => console.error(e))}>
        Sign in with Google
      </button>
    </div>
  )
}
