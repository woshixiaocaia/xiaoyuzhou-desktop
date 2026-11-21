import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'

const app = createApp(App)

// 插件都要在 mount 之前注册，否则根组件里拿不到 router / store
// 顺序：先装 Pinia 再装 Router，方便以后在路由守卫里直接使用 store
app.use(createPinia())
app.use(router)

app.mount('#app')
