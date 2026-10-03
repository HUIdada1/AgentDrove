import type { Directive } from 'vue'

interface SpotlightEl extends HTMLElement {
  __spotOff?: () => void
}

/**
 * 玻璃面板的"聚光边":光斑跟随光标,折射感来自边缘的方向性提亮。
 * 只写 CSS 变量不碰类名,把渲染留给纯 CSS;坐标按帧合并,
 * 避免每次 mousemove 都同步读布局触发 layout thrash。
 */
export const vSpotlight: Directive<SpotlightEl> = {
  mounted(el: SpotlightEl): void {
    let frame = 0
    let x = 0
    let y = 0

    const apply = (): void => {
      frame = 0
      const rect = el.getBoundingClientRect()
      el.style.setProperty('--mx', `${x - rect.left}px`)
      el.style.setProperty('--my', `${y - rect.top}px`)
    }

    const move = (event: MouseEvent): void => {
      x = event.clientX
      y = event.clientY
      if (!frame) frame = requestAnimationFrame(apply)
    }

    el.addEventListener('mousemove', move)
    el.__spotOff = () => {
      if (frame) cancelAnimationFrame(frame)
      el.removeEventListener('mousemove', move)
    }
  },
  unmounted(el: SpotlightEl): void {
    el.__spotOff?.()
  },
}
