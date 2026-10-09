/// <reference types="vite/client" />

// 渲染层全局类型：window.opentype 由 preload 注入，这里声明其形状，
// 让渲染代码获得完整类型提示，同时避免直接依赖 preload 的实现文件。

import type { OpenTypeApi } from '../preload/index'

declare global {
  interface Window {
    opentype: OpenTypeApi
  }
}

export {}
