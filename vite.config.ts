import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // Electron 生产模式通过 file:// 加载 dist/index.html。
  // 默认的绝对路径 /assets/... 在 file:// 下会被解析成 file:///assets/...，
  // 结果就是丢 CSS/JS、白屏。所以构建时改成相对路径 ./assets/...
  // 开发服务器仍是 '/'，npm run dev 的行为和以前完全一致。
  base: command === 'build' ? './' : '/',
  plugins: [
    vue(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
}))