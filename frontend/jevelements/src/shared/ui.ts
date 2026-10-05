// UI copy and helpers for the on-page toolbar and result drawers, so the same action
// always has the same label everywhere.
import type { Capture } from './types'

export const LABELS = {
  newSection: 'New section',
  copyPrompt: 'Copy prompt',
  viewScreenshot: 'View screenshot',
  copyScreenshot: 'Copy screenshot',
  copied: 'Copied',
  copyFailed: "Couldn't copy",
  downloaded: 'Downloaded',
  back: 'Back',
  close: 'Close',
} as const

// How long a button shows its confirmation ("Copied") before reverting.
export const FLASH_MS = 1400

// jev's classification, shown as tags. Empty when the backend wasn't reachable.
export function captureTags(capture: Capture): string[] {
  return capture.analysis ? [capture.analysis.sectionType.value, capture.analysis.layout.value] : []
}
