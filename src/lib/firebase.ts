import { initializeApp } from 'firebase/app'
import { GoogleAuthProvider, getAuth } from 'firebase/auth'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'
import { config } from '../config'

export const app = initializeApp(config.firebase)
export const auth = getAuth(app)
export const functions = getFunctions(app, config.region)
export const googleProvider = new GoogleAuthProvider()

// No Firestore client here on purpose. Every document this app owns is
// admin-SDK-only and reached through a typed callable — the SPA has no
// direct Firestore access by design, so importing `firebase/firestore`
// only ships a large unused module. The Firestore emulator still runs
// under `npm run dev`; the Functions side talks to it via the admin
// SDK, which needs no wiring from the client.
//
// Local dev: Functions go to the emulator, but Auth stays real so
// Google sign-in works without spinning up the Auth emulator and
// creating a fake user. Toggle with VITE_USE_EMULATORS=true.
if (config.useEmulators) {
  connectFunctionsEmulator(functions, 'localhost', 5001)
}
