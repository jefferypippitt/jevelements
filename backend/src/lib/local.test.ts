import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { PUT as putProject } from '@/app/api/captures/[id]/project/route'
import { GET as getFile, PUT as putFile } from '@/app/api/captures/[id]/files/[folder]/[name]/route'
import { GET as getZip } from '@/app/api/captures/[id]/zip/route'
import { recordRun, readRuns } from '@/lib/runs'
import { captureDir } from '@/lib/store'

const EXT = 'chrome-extension://abc'
const env = process.env as Record<string, string | undefined>
const saved = { NODE_ENV: env.NODE_ENV, JEV_API_TOKEN: env.JEV_API_TOKEN, JEV_EXTENSION_ID: env.JEV_EXTENSION_ID }

before(() => {
  env.NODE_ENV = 'production'
  delete env.JEV_API_TOKEN
  delete env.JEV_EXTENSION_ID
})

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
})

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false)
}

test('production records no runs and reads none back', async () => {
  const file = path.join(tmpdir(), 'jevelements-runs.json')
  const before = await readFile(file, 'utf8').catch(() => null)
  await recordRun({
    at: new Date().toISOString(), provider: 'typesafe', ok: true, url: 'https://private.example/page',
    model: null, sectionType: null, durationMs: 1, fallbackReason: null, error: null,
  })
  assert.equal(await readFile(file, 'utf8').catch(() => null), before)
  assert.deepEqual(await readRuns(), [])
})

test('production refuses capture uploads without writing anything', async () => {
  const id = randomUUID()
  const fileUrl = `http://localhost/api/captures/${id}/files/media/t.png`
  const put = new Request(fileUrl, { method: 'PUT', headers: { origin: EXT }, body: new Uint8Array([1, 2, 3]) })
  assert.equal((await putFile(put, { params: Promise.resolve({ id, folder: 'media', name: 't.png' }) })).status, 404)

  const project = new Request(`http://localhost/api/captures/${id}/project`, {
    method: 'PUT',
    headers: { origin: EXT, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'hero', component: 'Hero', file: 'hero', prompt: 'x' }),
  })
  assert.equal((await putProject(project, { params: Promise.resolve({ id }) })).status, 404)

  assert.equal(await exists(captureDir(id)), false)
  assert.equal((await getFile(new Request(fileUrl), { params: Promise.resolve({ id, folder: 'media', name: 't.png' }) })).status, 404)
  assert.equal((await getZip(new Request(`http://localhost/api/captures/${id}/zip`), { params: Promise.resolve({ id }) })).status, 404)
})
