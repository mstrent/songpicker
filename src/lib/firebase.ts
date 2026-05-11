import { initializeApp } from 'firebase/app'
import { GoogleAuthProvider, connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'
import { config } from '../config'

export const app = initializeApp(config.firebase)
export const auth = getAuth(app)
export const db = getFirestore(app)
export const functions = getFunctions(app, config.region)
export const googleProvider = new GoogleAuthProvider()

if (config.useEmulators) {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, 'localhost', 8080)
  connectFunctionsEmulator(functions, 'localhost', 5001)
}
