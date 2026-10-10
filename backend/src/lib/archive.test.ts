import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { after, test } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { appZip } from './archive'
import { captureDir, filePath, saveFile, saveProject } from './store'

function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.length - 22
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50)
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16) // central directory offset
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50)
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    assert.equal(buf.readUInt32LE(local), 0x04034b50)
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(dataStart, dataStart + size)
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const id = randomUUID()
const empty = randomUUID()
after(async () => {
  await rm(captureDir(id), { recursive: true, force: true })
  await rm(captureDir(empty), { recursive: true, force: true })
})

test('appZip returns null when nothing was saved', async () => {
  assert.equal(await appZip(empty), null)
})

test('appZip packs the scaffold, prompt and saved files under the project folder', async () => {
  await saveProject(id, { name: 'hero-section', component: 'HeroSection', file: 'hero-section', prompt: '# hi' })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
  assert.ok(await saveFile(filePath(id, ['media', 'hero.png'])!, png))
  assert.ok(await saveFile(filePath(id, ['code', 'app.js'])!, Buffer.from('console.log(1)')))

  const result = await appZip(id)
  assert.ok(result)
  assert.equal(result.name, 'hero-section')
  const entries = readZip(result.zip)
  const names = [...entries.keys()]
  assert.ok(names.every((n) => n.startsWith('hero-section/')))
  assert.equal(entries.get('hero-section/PROMPT.md')?.toString('utf8'), '# hi')
  assert.ok(!entries.has('hero-section/REMIX.md'))
  assert.deepEqual(entries.get('hero-section/public/capture/hero.png'), png)
  assert.ok(entries.has('hero-section/public/reference/code/app.js'))
  assert.ok(entries.has('hero-section/package.json'))
})

test('appZip ships the remix prompt as REMIX.md next to PROMPT.md', async () => {
  await saveProject(id, { name: 'hero-section', component: 'HeroSection', file: 'hero-section', prompt: '# clone', remix: '# remix' })
  const result = await appZip(id)
  assert.ok(result)
  const entries = readZip(result.zip)
  assert.equal(entries.get('hero-section/PROMPT.md')?.toString('utf8'), '# clone')
  assert.equal(entries.get('hero-section/REMIX.md')?.toString('utf8'), '# remix')
})
