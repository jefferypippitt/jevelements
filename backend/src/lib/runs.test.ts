import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { clearRuns, readRuns, recordRun, type Run } from '@/lib/runs'

const env = process.env as Record<string, string | undefined>
let savedEnv: string | undefined

// Own log file, so these tests never touch the developer's real log or race other test files.
before(() => {
  savedEnv = env.NODE_ENV
  env.NODE_ENV = 'development'
  env.JEV_RUNS_FILE = path.join(tmpdir(), `jevelements-runs-test-${process.pid}-${Date.now()}.json`)
})

after(async () => {
  await rm(env.JEV_RUNS_FILE!, { force: true })
  delete env.JEV_RUNS_FILE
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
