import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react(), {
    name: 'opentype-development-csp',
    transformIndexHtml(html, context) {
      // React's development refresh preamble is inline. Shipping HTML keeps script-src self.
      return context.server ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';") : html
    }
  }],
  root: 'src/renderer',
  base: './',
  server: { port: 7777 },
  worker: { format: 'es' },
  // worklet 通过 new URL(..., import.meta.url) 引用，需产出为 .js 才能被
  // audioWorklet.addModule() 加载（浏览器不认识 .ts 扩展名）
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'interactive-card': resolve(__dirname, 'src/renderer/interactive-card.html'),
        index: resolve(__dirname, 'src/renderer/index.html'),
        'speech-settings': resolve(__dirname, 'src/renderer/speech-settings.html'),
        'floating-bar': resolve(__dirname, 'src/renderer/floating-bar.html')
      },
      output: {
        assetFileNames: (info) => {
          // worklet 必须是 .js 且保留可预测文件名
          if (info.name?.includes('worklet')) return 'assets/[name]-[hash].js'
          return 'assets/[name]-[hash][extname]'
        }
      }
    }
  }
})
