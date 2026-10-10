// UI copy and helpers for the on-page toolbar and result drawers, so the same action
// always has the same label everywhere.
import type { Capture } from './types'

export const LABELS = {
  newSection: 'New Section',
  copyPrompt: 'Copy Prompt',
  copyRemix: 'Copy Remix Prompt',
  viewScreenshot: 'View Screenshot',
  copyScreenshot: 'Copy Screenshot',
  copied: 'Copied',
  copyFailed: "Couldn't Copy",
  downloaded: 'Downloaded',
  back: 'Back',
  close: 'Close',
} as const

// How long a button shows its confirmation ("Copied") before reverting.
export const FLASH_MS = 1400

// jev's classification, shown as tags: the family when it differs from the type (features · feature-rows),
// the type, and the layout. Empty when the backend wasn't reachable.
export function captureTags(capture: Capture): string[] {
  const analysis = capture.analysis
  if (!analysis) return []
  const family = analysis.sectionFamily?.value
  const withFamily = family && family !== 'other' && family !== analysis.sectionType.value ? [family] : []
  return [...withFamily, analysis.sectionType.value, analysis.layout.value]
}
