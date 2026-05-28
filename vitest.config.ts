import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Hook tests use React Testing Library + renderHook, which needs a
// DOM. Pure helper tests don't, but jsdom is cheap so we set it as
// the default. The react plugin gives Vitest the same JSX
// transform as the production build.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    // Suppress console output from product code (e.g., enrichSnippets
    // and lrclib timing logs) so test runs stay readable. Test code
    // can still use console.* via vi.spyOn if a test needs to assert
    // on it; this only mutes what production code emits.
    silent: 'passed-only',
  },
})
