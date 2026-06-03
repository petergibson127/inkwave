import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // bind 0.0.0.0 so the WSL2 dev server is reachable from the Windows browser
  },
})
