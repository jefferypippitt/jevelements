'use server'

import { refresh } from 'next/cache'
import { storesLocally } from '@/lib/local'
import { clearRuns } from '@/lib/runs'

// The status page's Delete all. Reachable by a direct POST like any Server Action, so it checks
// for itself: a deployed backend keeps no log and has nothing to clear.
export async function clearRunsAction(): Promise<void> {
  if (!storesLocally()) return
  await clearRuns()
  refresh()
}
