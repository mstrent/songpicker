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
  },
})
