// A short log of /api/analyze calls: which provider answered, and why TypeSafe was skipped when the
// AI Gateway fallback ran. The status page (app/page.tsx) reads it. Kept as one JSON file in the OS
// temp directory, next to the capture staging, so route handlers and the page see the same log.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const FILE = path.join(tmpdir(), 'jevelements-runs.json')
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
  pending = pending.then(async () => {
    const runs = [run, ...(await readRuns())].slice(0, MAX_RUNS)
    await mkdir(path.dirname(FILE), { recursive: true })
    const tmp = `${FILE}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(runs))
    await rename(tmp, FILE)
  }).catch((err) => console.warn('[runs] could not save run', err))
  return pending
}

// Newest first.
export async function readRuns(): Promise<Run[]> {
  try {
    const runs: unknown = JSON.parse(await readFile(FILE, 'utf8'))
    return Array.isArray(runs) ? (runs as Run[]) : []
  } catch {
    return []
  }
}
