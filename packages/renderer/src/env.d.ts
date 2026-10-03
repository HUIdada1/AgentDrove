/// <reference types="vite/client" />
import type { AgentDroveWindow } from '@agent-drove/shared'

declare global {
  const __APP_VERSION__: string
  interface Window extends AgentDroveWindow {}
}

export {}
