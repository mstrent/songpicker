import { defineSecret, defineString } from 'firebase-functions/params'

// Set with: firebase functions:secrets:set <NAME>
// Each defineSecret() call registers a secret with the runtime; the CLI then
// requires that secret to exist in Secret Manager at deploy time. Only define
// secrets you've actually set — re-add ANTHROPIC_API_KEY / OPENAI_API_KEY here
// when you're ready to enable those providers.
export const PCO_APP_ID = defineSecret('PCO_APP_ID')
export const PCO_SECRET = defineSecret('PCO_SECRET')
export const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY')

// Set with: firebase functions:config:set or via param env file
export const ALLOWED_EMAIL = defineString('ALLOWED_EMAIL', { default: '' })
export const AI_PROVIDER = defineString('AI_PROVIDER', { default: 'gemini' })
