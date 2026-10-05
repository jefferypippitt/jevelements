import { DEFAULT_SETTINGS } from './types'
import type { Settings } from './types'

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.sync.get('settings')
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) }
}
