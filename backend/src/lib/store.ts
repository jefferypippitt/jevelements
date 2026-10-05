// Files the extension saved for a capture: the real images, videos, canvas snapshots, textures and
// models the section showed (media/), its screenshot (frames/), and the page scripts holding its
// canvas code (code/). The extension's service worker downloads them from the live site, where
// neither CORS nor hotlink protection gets in the way, and uploads them here. project.json holds the
// app's name and prompt; archive.ts turns all of it into one Next.js app zip.
// Staging stays in the OS temp directory so nothing is written into this backend project.
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProjectNames } from './scaffold'

const ROOT = path.join(tmpdir(), 'jevelements-captures')
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_FILE_BYTES = 250 * 1024 * 1024
export const FOLDERS = ['media', 'frames', 'code'] as const
export type Folder = (typeof FOLDERS)[number]

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,90}$/i

export function isCaptureId(id: string): boolean {
  return ID_RE.test(id)
}

// Only `<folder>/<name>`, so a path from the request can never leave the capture's directory.
export function filePath(id: string, segments: string[]): string | null {
  if (!isCaptureId(id) || segments.length !== 2) return null
  const [folder, name] = segments
  if (!FOLDERS.includes(folder as Folder) || !NAME_RE.test(name) || name.includes('..')) return null
  return path.join(captureDir(id), folder, name)
}

// Files only the page itself could read arrive in chunks: offset 0 starts the file, later chunks
// append. Returns false when `offset` isn't where the file currently ends (a lost or repeated chunk).
export async function saveFile(file: string, bytes: Uint8Array, offset = 0): Promise<boolean> {
  if (offset === 0) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bytes)
    void purgeOld()
    return true
  }
  const size = await stat(file).then((s) => s.size, () => -1)
  if (size !== offset || offset + bytes.length > MAX_FILE_BYTES) return false
  await appendFile(file, bytes)
  return true
}

export function captureDir(id: string): string {
  return path.join(ROOT, id.toLowerCase())
}

export async function listFiles(id: string, folder: Folder): Promise<string[]> {
  if (!isCaptureId(id)) return []
  try {
    return (await readdir(path.join(captureDir(id), folder))).filter((n) => NAME_RE.test(n)).sort()
  } catch {
    return []
  }
}

export interface ProjectMeta extends ProjectNames {
  prompt: string // the copied prompt, shipped as PROMPT.md
}

const PROJECT_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/
const COMPONENT_RE = /^[A-Z][A-Za-z0-9]{0,80}$/
export const MAX_PROMPT_CHARS = 5_000_000

export function isProjectMeta(value: unknown): value is ProjectMeta {
  if (!value || typeof value !== 'object') return false
  const { name, component, file, prompt } = value as Record<string, unknown>
  return (
    typeof name === 'string' &&
    PROJECT_NAME_RE.test(name) &&
    typeof file === 'string' &&
    PROJECT_NAME_RE.test(file) &&
    typeof component === 'string' &&
    COMPONENT_RE.test(component) &&
    typeof prompt === 'string' &&
    prompt.length <= MAX_PROMPT_CHARS
  )
}

export async function saveProject(id: string, meta: ProjectMeta): Promise<void> {
  const dir = captureDir(id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'project.json'), JSON.stringify(meta))
  void purgeOld()
}

export async function readProject(id: string): Promise<ProjectMeta | null> {
  if (!isCaptureId(id)) return null
  try {
    const meta: unknown = JSON.parse(await readFile(path.join(captureDir(id), 'project.json'), 'utf8'))
    return isProjectMeta(meta) ? meta : null
  } catch {
    return null
  }
}

export async function readCaptureFile(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch {
    return null
  }
}

let lastPurge = 0

async function purgeOld() {
  const now = Date.now()
  if (now - lastPurge < 60 * 60 * 1000) return
  lastPurge = now
  try {
    for (const id of await readdir(ROOT)) {
      const dir = path.join(ROOT, id)
      if ((await stat(dir)).mtimeMs < now - MAX_AGE_MS) await rm(dir, { recursive: true, force: true })
    }
  } catch {
    // nothing saved yet
  }
}
