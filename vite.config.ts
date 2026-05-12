import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Single-user internal tool gated by ALLOWED_EMAIL; first-load
    // payload (~170 KB gzipped) is fine for the user we ship to, and
    // route-level code-splitting would add Suspense plumbing for no
    // real win. Bumping the warning threshold past where we sit so
    // the deploy log stays quiet without losing the signal entirely
    // — if the bundle ever balloons past 1 MB minified we'll hear
    // about it again.
    chunkSizeWarningLimit: 1000,
  },
})
