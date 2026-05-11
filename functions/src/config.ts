import { defineSecret, defineString } from 'firebase-functions/params'

// Set with: firebase functions:secrets:set <NAME>
// Each defineSecret() call registers a secret with the runtime; the CLI then
// requires that secret to exist in Secret Manager at deploy time. Only define
// secrets you've actually set.
//
// PCO credentials are now per-user (stored in Firestore at pcoCredentials/{uid}),
// not globals — see functions/src/pco/credentials.ts.
export const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY')
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')

// Set with: firebase functions:config:set or via param env file
export const ALLOWED_EMAIL = defineString('ALLOWED_EMAIL', { default: '' })
export const AI_PROVIDER = defineString('AI_PROVIDER', { default: 'gemini' })

// Comma-separated PCO service type names to include in listPlans.
// Empty string = include all (no filter).
// Example: "Sunday Services" or "Sunday Services,Saturday Service"
export const INCLUDED_SERVICE_TYPES = defineString('INCLUDED_SERVICE_TYPES', { default: '' })
