import { defineSecret, defineString } from 'firebase-functions/params'

// Set with: firebase functions:secrets:set <NAME>
// Each defineSecret() call registers a secret with the runtime; the CLI then
// requires that secret to exist in Secret Manager at deploy time. Only define
// secrets you've actually set.
//
// PCO credentials are now per-user (stored in Firestore at pcoCredentials/{uid}),
// not globals — see functions/src/pco/credentials.ts.
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')

// Set with: firebase functions:config:set or via param env file
export const ALLOWED_EMAIL = defineString('ALLOWED_EMAIL', { default: '' })

// Comma-separated emails of users who can edit the system-wide prompt
// defaults via the Admin page. Empty disables the admin page entirely.
export const ADMIN_EMAILS = defineString('ADMIN_EMAILS', { default: '' })

// Comma-separated PCO service type names to include in listPlans.
// Empty string = include all (no filter).
// Example: "Sunday Services" or "Sunday Services,Saturday Service"
export const INCLUDED_SERVICE_TYPES = defineString('INCLUDED_SERVICE_TYPES', { default: '' })
