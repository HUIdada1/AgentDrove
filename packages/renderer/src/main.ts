import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles.css'
import { installAppBridge } from './stores/app'
import { vSpotlight } from './ui/spotlight'

if (import.meta.env.DEV && !window.api) {
  // 浏览器直开时注入样例数据,让 UI 开发与视觉审查可以脱离 Electron 进行;
  // 加载失败也照常挂载(页面显示空态),而不是整屏白掉
  try {
    const { installDevMock } = await import('./mock')
    installDevMock()
  } catch {
    // mock 仅为开发辅助,缺失不阻断
  }
}

installAppBridge()
createApp(App).use(createPinia()).directive('spotlight', vSpotlight).mount('#app')
