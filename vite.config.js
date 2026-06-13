import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IMPORTANT: `base` must match your GitHub repo name exactly.
// Site will be served at https://<user>.github.io/trading-journal/
// If you rename the repo, update this and redeploy.
export default defineConfig({
  plugins: [react()],
  base: '/rugpull/',
})
