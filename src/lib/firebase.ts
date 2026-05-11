import { initializeApp } from 'firebase/app'
import { GoogleAuthProvider, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'
import { config } from '../config'

export const app = initializeApp(config.firebase)
export const auth = getAuth(app)
export const db = getFirestore(app)
export const functions = getFunctions(app, config.region)
export const googleProvider = new GoogleAuthProvider()

// Local dev: Functions + Firestore go to the emulators, but Auth stays
// real so Google sign-in works without spinning up the Auth emulator
// and creating a fake user. Toggle with VITE_USE_EMULATORS=true.
if (config.useEmulators) {
  connectFirestoreEmulator(db, 'localhost', 8080)
  connectFunctionsEmulator(functions, 'localhost', 5001)
}
