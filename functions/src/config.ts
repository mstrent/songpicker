import { defineSecret, defineString } from 'firebase-functions/params'

// Set with: firebase functions:secrets:set <NAME>
export const PCO_APP_ID = defineSecret('PCO_APP_ID')
export const PCO_SECRET = defineSecret('PCO_SECRET')
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')
export const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY')

// Set with: firebase functions:config:set or via param env file
export const ALLOWED_EMAIL = defineString('ALLOWED_EMAIL', { default: '' })
export const AI_PROVIDER = defineString('AI_PROVIDER', { default: 'anthropic' })
