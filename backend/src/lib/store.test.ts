import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { captureDir, filePath, isCaptureId, isProjectMeta, MAX_PROMPT_CHARS, readCaptureFile, saveFile } from './store'

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const meta = { name: 'hero-section', component: 'HeroSection', file: 'hero-section', prompt: 'x' }

test('isCaptureId accepts lowercase and uppercase UUIDs', () => {
  assert.equal(isCaptureId(UUID), true)
  assert.equal(isCaptureId(UUID.toUpperCase()), true)
})

test('isCaptureId rejects malformed ids', () => {
  assert.equal(isCaptureId('abc'), false)
  assert.equal(isCaptureId(''), false)
  assert.equal(isCaptureId(`${UUID}/x`), false)
})

test('filePath resolves folder/name inside the capture', () => {
  const p = filePath(UUID, ['media', 'hero.png'])
  assert.ok(p !== null && p.endsWith(path.join('media', 'hero.png')))
})

test('filePath rejects anything that could leave the capture', () => {
  assert.equal(filePath(UUID, ['other', 'hero.png']), null)
  assert.equal(filePath(UUID, ['media', 'a', 'b.png']), null)
  assert.equal(filePath(UUID, ['media', '..']), null)
  assert.equal(filePath(UUID, ['media', 'a..b.png']), null)
  assert.equal(filePath(UUID, ['media', '.hidden']), null)
  assert.equal(filePath(UUID, ['media', '-dash']), null)
  assert.equal(filePath(UUID, ['media', 'a'.repeat(92)]), null)
  assert.equal(filePath(UUID, ['media', 'a/b.png']), null)
  assert.equal(filePath(UUID, ['media', 'a\\b.png']), null)
  assert.equal(filePath('abc', ['media', 'hero.png']), null)
})

test('isProjectMeta accepts valid metadata', () => {
  assert.equal(isProjectMeta(meta), true)
})

test('isProjectMeta rejects invalid metadata', () => {
  assert.equal(isProjectMeta({ ...meta, name: 'Hero' }), false)
  assert.equal(isProjectMeta({ ...meta, component: 'heroSection' }), false)
  assert.equal(isProjectMeta({ name: meta.name, component: meta.component, file: meta.file }), false)
  assert.equal(isProjectMeta({ ...meta, prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }), false)
  assert.equal(isProjectMeta(null), false)
})

const id = randomUUID()
after(() => rm(captureDir(id), { recursive: true, force: true }))

test('saveFile writes at 0, appends at the current size, refuses repeats', async () => {
  const file = filePath(id, ['media', 'chunk.bin'])
  assert.ok(file)
  assert.equal(await saveFile(file, Uint8Array.from([1, 2, 3]), 0), true)
  assert.equal(await saveFile(file, Uint8Array.from([4, 5, 6]), 3), true)
  assert.equal(await saveFile(file, Uint8Array.from([7, 8, 9]), 3), false)
  assert.deepEqual([...(await readCaptureFile(file))!], [1, 2, 3, 4, 5, 6])
  assert.equal(await saveFile(file, Uint8Array.from([9]), 0), true)
  assert.deepEqual([...(await readCaptureFile(file))!], [9])
})
