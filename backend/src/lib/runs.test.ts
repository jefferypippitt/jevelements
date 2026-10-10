import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { clearRuns, readRuns, recordRun, type Run } from '@/lib/runs'

const env = process.env as Record<string, string | undefined>
const file = path.join(tmpdir(), 'jevelements-runs.json')
let savedEnv: string | undefined
let backup: string | null = null

// The log lives at a fixed path in the real temp dir, so keep the developer's copy and put it back.
before(async () => {
  savedEnv = env.NODE_ENV
  env.NODE_ENV = 'development'
  backup = await readFile(file, 'utf8').catch(() => null)
})

after(async () => {
  if (backup !== null) await writeFile(file, backup)
  else await rm(file, { force: true })
  if (savedEnv === undefined) delete env.NODE_ENV
  else env.NODE_ENV = savedEnv
})

function run(): Run {
  return {
    at: new Date().toISOString(),
    provider: 'typesafe',
    ok: true,
    url: 'https://example.com',
    model: null,
    sectionType: null,
    durationMs: 1,
    fallbackReason: null,
    error: null,
  }
}

test('clearRuns empties the log', async () => {
  await recordRun(run())
  assert.ok((await readRuns()).length >= 1)
  await clearRuns()
  assert.deepEqual(await readRuns(), [])
})

test('clearRuns does nothing in production', async () => {
  await recordRun(run())
  env.NODE_ENV = 'production'
  try {
    await clearRuns()
  } finally {
    env.NODE_ENV = 'development'
  }
  assert.ok((await readRuns()).length >= 1)
})
