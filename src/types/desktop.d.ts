/**
 * 全局类型声明：preload 通过 contextBridge 暴露的 `window.desktop`。
 *
 * 只做声明，不含任何实现。
 * 非 Electron 环境（例如直接用浏览器打开 `npm run dev`）下 `window.desktop`
 * 是 undefined，调用方必须先用 `isDesktopBridgeAvailable()` 判断。
 */
import type { DesktopBridge } from '@/lib/desktop'

declare global {
  interface Window {
    desktop?: DesktopBridge
  }
}

export {}
