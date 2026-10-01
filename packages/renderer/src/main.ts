import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles.css'
import { installAppBridge } from './stores/app'

if (import.meta.env.DEV && !window.api) {
  // 浏览器直开时注入样例数据,让 UI 开发与视觉审查可以脱离 Electron 进行
  const { installDevMock } = await import('./mock')
  installDevMock()
}

installAppBridge()
createApp(App).use(createPinia()).mount('#app')
