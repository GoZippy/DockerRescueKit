import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig(() => ({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@docker-rescue-kit/shared': path.resolve(__dirname, '../shared/src/types.ts'),
    },
  },
  define: {
    'import.meta.env.VITE_TRANSPORT': JSON.stringify(process.env.VITE_TRANSPORT ?? 'tcp'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:42880',
        changeOrigin: true,
      },
    },
  },
}))
