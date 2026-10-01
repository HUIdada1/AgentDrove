import type { Directive } from 'vue'

/**
 * 玻璃面板的"聚光边":光斑跟随光标,折射感来自边缘的方向性提亮。
 * 只写 CSS 变量不碰类名,把渲染留给纯 CSS。
 */
export const vSpotlight: Directive<HTMLElement> = {
  mounted(el: HTMLElement & { __spotOff?: () => void }): void {
    const move = (event: MouseEvent): void => {
      const rect = el.getBoundingClientRect()
      el.style.setProperty('--mx', `${event.clientX - rect.left}px`)
      el.style.setProperty('--my', `${event.clientY - rect.top}px`)
    }
    el.addEventListener('mousemove', move)
    el.__spotOff = () => el.removeEventListener('mousemove', move)
  },
  unmounted(el: HTMLElement & { __spotOff?: () => void }): void {
    el.__spotOff?.()
  },
}
