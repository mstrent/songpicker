import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { PcoClient } from './client'

export interface StoredPcoCredentials {
  appId: string
  secret: string
  updatedAt: FirebaseFirestore.FieldValue | Date
}

const collection = 'pcoCredentials'

export async function loadPcoCredentials(uid: string): Promise<{ appId: string; secret: string }> {
  const snap = await getFirestore().doc(`${collection}/${uid}`).get()
  if (!snap.exists) {
    throw new HttpsError(
      'failed-precondition',
      'Planning Center credentials not set. Add them from the songpicker setup screen.',
    )
  }
  const data = snap.data() as { appId?: unknown; secret?: unknown } | undefined
  if (
    !data ||
    typeof data.appId !== 'string' ||
    typeof data.secret !== 'string' ||
    !data.appId ||
    !data.secret
  ) {
    throw new HttpsError('failed-precondition', 'Planning Center credentials malformed; please re-enter.')
  }
  return { appId: data.appId, secret: data.secret }
}

export async function pcoForUser(uid: string): Promise<PcoClient> {
  const creds = await loadPcoCredentials(uid)
  return new PcoClient(creds.appId, creds.secret)
}

export async function savePcoCredentialsForUser(
  uid: string,
  appId: string,
  secret: string,
): Promise<void> {
  await getFirestore()
    .doc(`${collection}/${uid}`)
    .set(
      {
        appId,
        secret,
        updatedAt: new Date(),
      },
      { merge: true },
    )
}

export async function hasPcoCredentials(uid: string): Promise<boolean> {
  const snap = await getFirestore().doc(`${collection}/${uid}`).get()
  if (!snap.exists) return false
  const data = snap.data() as { appId?: unknown; secret?: unknown } | undefined
  return !!(
    data &&
    typeof data.appId === 'string' &&
    typeof data.secret === 'string' &&
    data.appId &&
    data.secret
  )
}
