import type { ContentMessage } from './types'

// Injects the content script into a tab (a no-op if it is already there) and sends it a command.
export async function sendToInspector(tabId: number, message: ContentMessage): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
  await chrome.tabs.sendMessage(tabId, message)
}
