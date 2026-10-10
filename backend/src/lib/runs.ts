// A short log of /api/analyze calls: which provider answered, and why TypeSafe was skipped when the
// AI Gateway fallback ran. The status page (app/page.tsx) reads it. Kept as one JSON file in the OS
// temp directory, next to the capture staging, so route handlers and the page see the same log.
// Local development only: in production nothing is recorded, so no captured page URL is kept.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { storesLocally } from './local'

// JEV_RUNS_FILE moves the log (tests use their own file, so they never touch the developer's).
function runsFile(): string {
  return process.env.JEV_RUNS_FILE || path.join(tmpdir(), 'jevelements-runs.json')
}
const MAX_RUNS = 200

export type Provider = 'typesafe' | 'gateway' | 'none'

export interface Run {
  at: string // ISO time the request started
  provider: Provider // who produced the answer, or who failed last
  ok: boolean
  url?: string // page the section was captured from; missing on runs logged before it was recorded
  model: string | null
  sectionType: string | null
  durationMs: number
  fallbackReason: string | null // TypeSafe's error when the gateway was used instead
  error: string | null
}

let pending: Promise<void> = Promise.resolve()

// Serialized so two analyses finishing together don't overwrite each other's entry.
export function recordRun(run: Run): Promise<void> {
  if (!storesLocally()) return Promise.resolve()
  pending = pending.then(async () => {
    const runs = [run, ...(await readRuns())].slice(0, MAX_RUNS)
    await mkdir(path.dirname(runsFile()), { recursive: true })
    const tmp = `${runsFile()}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(runs))
    await rename(tmp, runsFile())
  }).catch((err) => console.warn('[runs] could not save run', err))
  return pending
}

// Empties the log (the status page's Delete all). Queued behind any run still being written, so a
// run that finishes during the clear can't bring the old entries back.
export function clearRuns(): Promise<void> {
  if (!storesLocally()) return Promise.resolve()
  pending = pending.then(() => rm(runsFile(), { force: true })).catch((err) => console.warn('[runs] could not clear runs', err))
  return pending
}

// Newest first.
export async function readRuns(): Promise<Run[]> {
  if (!storesLocally()) return []
  try {
    const runs: unknown = JSON.parse(await readFile(runsFile(), 'utf8'))
    return Array.isArray(runs) ? (runs as Run[]) : []
  } catch {
    return []
  }
}
