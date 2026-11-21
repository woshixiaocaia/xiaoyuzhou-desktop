import { globalIgnores } from 'eslint/config'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

/**
 * ESLint 9/10 只支持 flat config（扁平配置）。
 * 这里的顺序 = 后面覆盖前面：基础设置 → 忽略 → Vue 规则 → TS 规则 → 本项目自定义。
 */
export default defineConfigWithVueTs(
  {
    name: 'app/files-to-lint',
    files: ['**/*.{ts,mts,tsx,vue}'],
    languageOptions: {
      // 声明浏览器全局变量（document、window 等），避免被当成未定义变量
      globals: {
        ...globals.browser,
      },
    },
  },

  // 构建产物、依赖目录、Electron 打包输出都不检查
  globalIgnores(['**/dist/**', '**/dist-ssr/**', '**/coverage/**', '**/release/**']),

  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,

  {
    name: 'app/rules',
    rules: {
      // 初学者阶段先放开组件名单词数限制，避免为了规则而去凑名字
      'vue/multi-word-component-names': 'off',

      // 下面 5 条只关心「空格和换行」，属于格式化工具的职责。
      // 本项目不装 Prettier，所以关掉它们，让 lint 只报真正的问题（逻辑、类型、可读性）。
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/html-indent': 'off',
    },
  },

  // Electron 的 Node 侧代码：主进程、预加载脚本、开发启动器。
  // 它们跑在 Node 里而不是浏览器里，全局变量是 process / __dirname 这一套。
  {
    name: 'app/electron-node-files',
    files: ['electron/**/*.{js,cjs}', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // 预加载脚本在 sandbox: true 下必须是 CommonJS，因此 require() 是唯一合法写法
  {
    name: 'app/electron-preload',
    files: ['electron/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)