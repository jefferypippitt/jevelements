// Content script entry. Injected on demand (popup button or keyboard shortcut), so it guards
// against running twice in the same tab.
import type { ContentMessage } from '../shared/types'
import { Inspector } from './inspector'

declare global {
  interface Window {
    __jevInspector?: Inspector
  }
}

if (!window.__jevInspector) {
  const inspector = new Inspector()
  window.__jevInspector = inspector

  chrome.runtime.onMessage.addListener((message: ContentMessage) => {
    if (message.type === 'jev:toggle') inspector.toggle()
    else if (message.type === 'jev:interrupted') inspector.interrupted(message.from, message.to)
  })
}
