/// <reference types="vite/client" />
import type { AgentDroveWindow } from '@agent-drove/shared'

declare const __APP_VERSION__: string

declare global {
  interface Window extends AgentDroveWindow {}
}

export {}
