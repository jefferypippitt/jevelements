import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { POST as analyze } from '@/app/api/analyze/route'
import { PUT as putProject } from '@/app/api/captures/[id]/project/route'
import { GET as getFile, PUT as putFile } from '@/app/api/captures/[id]/files/[folder]/[name]/route'
import { captureDir } from '@/lib/store'

const EVIL = 'https://evil.example'
const EXT = 'chrome-extension://abc'
const id = randomUUID()
const saved: Record<string, string | undefined> = {}

before(() => {
  for (const key of ['JEV_API_TOKEN', 'JEV_EXTENSION_ID']) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(captureDir(id), { recursive: true, force: true })
})

function send(url: string, method: string, origin: string, type: string | null, body: BodyInit) {
  const headers: Record<string, string> = { origin }
  if (type) headers['content-type'] = type
  return new Request(url, { method, headers, body })
}

const fileCtx = { params: Promise.resolve({ id, folder: 'media', name: 't.png' }) }
const projectCtx = { params: Promise.resolve({ id }) }

test('analyze refuses a web page origin before reading the body', async () => {
  const res = await analyze(send('http://localhost/api/analyze', 'POST', EVIL, 'text/plain', '{}'))
  assert.equal(res.status, 403)
})

test('analyze refuses a non-JSON content type from the extension', async () => {
  const res = await analyze(send('http://localhost/api/analyze', 'POST', EXT, 'text/plain', '{}'))
  assert.equal(res.status, 415)
})

test('analyze rejects a JSON body that is not a capture without calling the classifier', async () => {
  const res = await analyze(send('http://localhost/api/analyze', 'POST', EXT, 'application/json', '{}'))
  assert.equal(res.status, 400)
})

test('project PUT checks origin, then content type', async () => {
  const url = `http://localhost/api/captures/${id}/project`
  assert.equal((await putProject(send(url, 'PUT', EVIL, 'application/json', '{}'), projectCtx)).status, 403)
  assert.equal((await putProject(send(url, 'PUT', EXT, 'text/plain', '{}'), projectCtx)).status, 415)
})

test('file PUT refuses a web page origin, saves from the extension, and GET serves it hardened', async () => {
  const url = `http://localhost/api/captures/${id}/files/media/t.png`
  const bytes = new Uint8Array([1, 2, 3])
  assert.equal((await putFile(send(url, 'PUT', EVIL, null, bytes), fileCtx)).status, 403)
  assert.equal((await putFile(send(url, 'PUT', EXT, null, bytes), fileCtx)).status, 200)

  const res = await getFile(new Request(url), fileCtx)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/)
})
