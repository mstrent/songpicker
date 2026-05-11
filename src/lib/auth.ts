import { signInWithPopup, signOut } from 'firebase/auth'
import { auth, googleProvider } from './firebase'

export const signIn = () => signInWithPopup(auth, googleProvider)
export const logOut = () => signOut(auth)
