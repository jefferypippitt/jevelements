// A capture as one Next.js app zip, everything under a single `<name>/` folder: the scaffold
// (scaffold.ts), PROMPT.md, REMIX.md, and public/ with the files the extension saved — media → public/capture/, fonts → public/fonts/,
// the screenshot → public/reference/, canvas source code → public/reference/code/. Extracting it gives
// a ready app; nothing is written anywhere but the response.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { scaffold } from './scaffold'
import { captureDir, FOLDERS, listFiles, readProject, type Folder, type ProjectMeta } from './store'

// Paths the prompt refers to (/capture/…, /reference/…), so keep them in sync with
// frontend/jevelements/src/shared/prompt.ts.
const DIRS: Record<Folder, string> = { media: 'public/capture', frames: 'public/reference', code: 'public/reference/code', fonts: 'public/fonts' }

// Until the extension sends project.json, the files still download as a generic app.
const FALLBACK: ProjectMeta = { name: 'section', component: 'Section', file: 'section', prompt: '' }

interface Entry {
  name: string
  body: Buffer
  deflate: boolean // text compresses well; media is already compressed
}

export async function appZip(id: string): Promise<{ name: string; zip: Buffer } | null> {
  const project = (await readProject(id)) ?? FALLBACK
  const assets: Entry[] = []
  for (const folder of FOLDERS) {
    for (const file of await listFiles(id, folder)) {
      assets.push({ name: `${DIRS[folder]}/${file}`, body: await readFile(path.join(captureDir(id), folder, file)), deflate: folder === 'code' })
    }
  }
  if (!assets.length && project === FALLBACK) return null

  const text = (name: string, body: string): Entry => ({ name, body: Buffer.from(body, 'utf8'), deflate: true })
  const entries = [
    ...scaffold(project).map((f) => text(f.path, f.body)),
    ...(project.prompt ? [text('PROMPT.md', project.prompt)] : []),
    ...(project.remix ? [text('REMIX.md', project.remix)] : []),
    ...assets,
  ].map((e) => ({ ...e, name: `${project.name}/${e.name}` }))
  return { name: project.name, zip: zip(entries) }
}

function zip(entries: Entry[]): Buffer {
  const { time, date } = dosDateTime(new Date())
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, body, deflate } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(body)
    const data = deflate ? deflateRawSync(body) : body
    const method = deflate ? 8 : 0
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4) // version needed
    head.writeUInt16LE(0x0800, 6) // UTF-8 names
    head.writeUInt16LE(method, 8)
    head.writeUInt16LE(time, 10)
    head.writeUInt16LE(date, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(body.length, 22)
    head.writeUInt16LE(nameBytes.length, 26)
    local.push(head, nameBytes, data)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(0x0314, 4) // made by: Unix, 2.0
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(method, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(body.length, 24)
    dir.writeUInt16LE(nameBytes.length, 28)
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38) // rw-r--r-- regular file
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBytes)

    offset += head.length + nameBytes.length + data.length
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}
