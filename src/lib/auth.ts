import { signInWithPopup, signOut } from 'firebase/auth'
import { auth, googleProvider } from './firebase'
import { recordSignIn } from './api'

// Record the sign-in metric here — at the actual popup-success seam —
// rather than from onAuthStateChanged. The state listener also fires
// when Firebase rehydrates a persisted session on page reload, which
// would otherwise count every reload as a sign-in.
export async function signIn() {
  const result = await signInWithPopup(auth, googleProvider)
  recordSignIn().catch(() => {})
  return result
}

export const logOut = () => signOut(auth)
