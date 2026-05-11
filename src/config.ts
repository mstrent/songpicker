const env = import.meta.env

export const config = {
  firebase: {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  },
  region: env.VITE_FIREBASE_REGION ?? 'us-central1',
  allowedEmail: env.VITE_ALLOWED_EMAIL ?? '',
  useEmulators: env.VITE_USE_EMULATORS === 'true',
  // Overrides user.displayName when matching against PCO worshipLeaders.
  // Set this if your Google account name differs from your PCO name.
  leaderName: env.VITE_LEADER_NAME ?? '',
}
