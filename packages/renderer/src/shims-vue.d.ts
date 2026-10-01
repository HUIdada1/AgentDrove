// .vue 单文件组件不是 TS 文件,tsc 靠这个通配声明把导入当组件类型处理
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
