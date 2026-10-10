import { defineConfig } from 'tsup'

// 主进程与 preload 统一构建为 CJS。
//
// 为什么不用 ESM：Electron 33 内置 Node 20，其 ESM 加载器在链接 CJS 依赖
// （koffi / better-sqlite3 / undici / drizzle-orm）时会在预解析阶段崩溃
// （Cannot read properties of undefined (reading 'exports')）。
// CJS 主进程是 Electron 生态的稳妥路径，且这些依赖本身就是 CJS 实现。
export default defineConfig([
  {
    entry: { index: 'src/main/index.ts', 'sensevoice-worker': 'src/main/services/local-asr/sensevoice-worker.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    outDir: 'dist/main',
    clean: true,
    sourcemap: true,
    external: ['electron', 'original-fs', 'better-sqlite3', 'koffi', 'undici', 'electron-store', 'electron-updater', 'sherpa-onnx-node', 'ogg-opus-decoder']
  },
  {
    entry: { index: 'src/preload/index.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    outDir: 'dist/preload',
    clean: true,
    sourcemap: true,
    external: ['electron']
  }
])
