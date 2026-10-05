// Reads a three.js scene the page renders: renderer settings, camera, scene graph, materials, custom
// shaders with their uniform values, textures, and which values animate (sampled over a short window).
// Also exports the main scene with Object3D.toJSON(), which THREE.ObjectLoader loads back as-is.
import type { ShaderSource, ThreeData } from '../shared/types'
import { label } from '../shared/dom'
import { hex, literal, round, truncateText } from './format'
import type { HookState, ThreeRenderer } from './hooks'

const MAX_OUTLINE_LINES = 220
const MAX_DEPTH = 12
const MAX_SAMPLED_OBJECTS = 300
const MAX_JSON_VERTICES = 400_000
const MAX_JSON_CHARS = 20_000_000
const MAX_PATCH_CHARS = 3000

const TONE_MAPPING = ['None', 'Linear', 'Reinhard', 'Cineon', 'ACESFilmic', 'Custom', 'AgX', 'Neutral']
const SHADOW_TYPES = ['Basic', 'PCF', 'PCFSoft', 'VSM']
const SIDES = ['FrontSide', 'BackSide', 'DoubleSide']
const BLENDING = ['NoBlending', 'NormalBlending', 'AdditiveBlending', 'SubtractiveBlending', 'MultiplyBlending', 'CustomBlending']
const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap', 'bumpMap',
  'displacementMap', 'envMap', 'matcap', 'lightMap', 'specularMap', 'clearcoatNormalMap', 'transmissionMap', 'gradientMap',
]
const IMAGE_FILE_RE = /\.(png|jpe?g|webp|avif|ktx2|basis|hdr|exr)(\?|#|$)/i

interface Vec {
  x: number
  y: number
  z?: number
  w?: number
}
interface Color {
  r: number
  g: number
  b: number
  isColor?: boolean
  getHexString?: () => string
}
interface Texture {
  isTexture: true
  image?: unknown
}
interface Geometry {
  type: string
  parameters?: Record<string, unknown>
  attributes?: { position?: { count: number } }
}
interface Material {
  uuid: string
  type: string
  name?: string
  vertexShader?: string
  fragmentShader?: string
  uniforms?: Record<string, { value: unknown }>
  onBeforeCompile?: { toString(): string }
  [prop: string]: unknown
}
interface Object3D {
  uuid: string
  type: string
  name: string
  visible: boolean
  children: Object3D[]
  position: Vec
  rotation: Vec
  scale: Vec
  geometry?: Geometry
  material?: Material | Material[]
  count?: number
  isLight?: boolean
  color?: Color
  intensity?: number
  castShadow?: boolean
  fov?: number
  near?: number
  far?: number
  zoom?: number
  aspect?: number
  left?: number
  right?: number
  top?: number
  bottom?: number
  background?: Color | Texture | null
  environment?: Texture | null
  fog?: { color: Color; near?: number; far?: number; density?: number } | null
  animations?: { name: string; duration: number }[]
  toJSON?: () => unknown
}
interface Renderer extends ThreeRenderer {
  getPixelRatio?: () => number
  toneMapping?: number
  toneMappingExposure?: number
  outputColorSpace?: string
  outputEncoding?: number
  shadowMap?: { enabled: boolean; type: number }
  getClearColor?: (target: Color & { copy(c: Color): unknown }) => unknown
  getClearAlpha?: () => number
}

const isTexture = (v: unknown): v is Texture => !!v && typeof v === 'object' && (v as Texture).isTexture === true
const isColor = (v: unknown): v is Color => !!v && typeof v === 'object' && (v as Color).isColor === true
const isVector = (v: unknown): v is Vec =>
  !!v && typeof v === 'object' && typeof (v as Vec).x === 'number' && typeof (v as Vec).y === 'number' && !('elements' in v)

function colorHex(c: Color): string {
  try {
    if (c.getHexString) return `#${c.getHexString()}` // converts from three's linear working space to sRGB
  } catch {
    // older three.js
  }
  return hex(c.r, c.g, c.b)
}

function vec(v: Vec): string {
  return `(${[v.x, v.y, v.z, v.w].filter((n) => n !== undefined).map((n) => round(n!)).join(', ')})`
}

function numbers(v: unknown): number[] | null {
  if (typeof v === 'number') return [v]
  if (isColor(v)) return [v.r, v.g, v.b]
  if (isVector(v)) return [v.x, v.y, v.z, v.w].filter((n): n is number => typeof n === 'number')
  return null
}

function textureUrl(t: Texture): string {
  const image = Array.isArray(t.image) ? t.image[0] : t.image
  if (image instanceof HTMLImageElement) return image.currentSrc || image.src
  if (image instanceof HTMLVideoElement) return `video ${image.currentSrc}`
  if (image instanceof HTMLCanvasElement) return '(drawn on a canvas at runtime)'
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) return `(ImageBitmap ${image.width}×${image.height}, decoded from a fetched file; see the texture files below)`
  if (image && typeof image === 'object' && 'data' in image) return '(generated data texture)'
  return '(texture)'
}

function walk(obj: Object3D, visit: (o: Object3D, depth: number) => void, depth = 0) {
  visit(obj, depth)
  if (depth < MAX_DEPTH) for (const child of obj.children ?? []) walk(child, visit, depth + 1)
}

function materialsOf(obj: Object3D): Material[] {
  if (!obj.material) return []
  return Array.isArray(obj.material) ? obj.material : [obj.material]
}

// ---------- sampling ----------

type Samples = Map<string, number[]>

function sample(scene: Object3D, camera: Object3D, materials: Material[]): Samples {
  const out: Samples = new Map()
  let n = 0
  walk(scene, (o) => {
    if (n++ > MAX_SAMPLED_OBJECTS) return
    out.set(`${o.uuid}|position`, [o.position.x, o.position.y, o.position.z ?? 0])
    out.set(`${o.uuid}|rotation`, [o.rotation.x, o.rotation.y, o.rotation.z ?? 0])
    out.set(`${o.uuid}|scale`, [o.scale.x, o.scale.y, o.scale.z ?? 0])
  })
  out.set('camera|position', [camera.position.x, camera.position.y, camera.position.z ?? 0])
  out.set('camera|rotation', [camera.rotation.x, camera.rotation.y, camera.rotation.z ?? 0])
  for (const m of materials) {
    for (const [name, u] of Object.entries(m.uniforms ?? {})) {
      const v = numbers(u?.value)
      if (v) out.set(`${m.uuid}|uniform|${name}`, v)
    }
  }
  return out
}

// "rotation.y +0.52/s, rotation.x +0.1/s" for every sampled value that moved.
function rates(before: Samples, after: Samples, seconds: number): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, a] of before) {
    const b = after.get(key)
    if (!b) continue
    const [id, ...rest] = key.split('|')
    const prop = rest.at(-1)!
    const changes = a
      .map((value, i) => ({ i, delta: (b[i] - value) / seconds }))
      .filter(({ delta }) => Math.abs(delta) > 1e-4)
      .map(({ i, delta }) => `${a.length > 1 ? `${prop}.${'xyzw'[i]}` : prop} ${delta > 0 ? '+' : ''}${round(delta)}/s`)
    if (changes.length) {
      const target = rest[0] === 'uniform' ? `${id}|uniform|${prop}` : id
      out.set(target, [out.get(target), ...changes].filter(Boolean).join(', '))
    }
  }
  return out
}

// ---------- description ----------

function uniformText(name: string, value: unknown, rate?: string): string {
  let text: string
  if (isTexture(value)) text = `texture ${textureUrl(value)}`
  else if (isColor(value)) text = colorHex(value)
  else if (isVector(value)) text = vec(value)
  else if (value && typeof value === 'object' && 'elements' in value) text = '(matrix)'
  else if (Array.isArray(value)) text = value.length && typeof value[0] === 'number' ? literal(value) : `[${value.length} items]`
  else text = literal(value)
  return `${name}: ${text}${rate ? `  (animating: ${rate.startsWith(`${name} `) ? rate.slice(name.length + 1) : rate})` : ''}`
}

function shaderOf(m: Material, name: string, animated: Map<string, string>): ShaderSource {
  return {
    name,
    vertex: m.vertexShader ?? '',
    fragment: m.fragmentShader ?? '',
    uniforms: Object.entries(m.uniforms ?? {}).map(([u, { value }]) => uniformText(u, value, animated.get(`${m.uuid}|uniform|${u}`))),
  }
}

function materialText(m: Material, index: number, animated: Map<string, string>): string {
  const parts = [`#${index} ${m.type}${m.name ? ` "${m.name}"` : ''}`]
  if (isColor(m.color)) parts.push(`color ${colorHex(m.color)}`)
  if (isColor(m.emissive) && colorHex(m.emissive) !== '#000000') parts.push(`emissive ${colorHex(m.emissive)} × ${m.emissiveIntensity ?? 1}`)
  for (const key of ['roughness', 'metalness', 'transmission', 'thickness', 'ior', 'clearcoat', 'clearcoatRoughness', 'sheen', 'iridescence', 'envMapIntensity', 'size']) {
    const v = m[key]
    if (typeof v === 'number' && (key === 'roughness' || key === 'metalness' || v !== 0)) parts.push(`${key} ${round(v)}`)
  }
  if (m.transparent || (typeof m.opacity === 'number' && m.opacity < 1)) parts.push(`transparent, opacity ${round(m.opacity as number)}`)
  if (typeof m.side === 'number' && m.side !== 0) parts.push(SIDES[m.side] ?? `side ${m.side}`)
  if (typeof m.blending === 'number' && m.blending !== 1) parts.push(BLENDING[m.blending] ?? `blending ${m.blending}`)
  if (m.wireframe) parts.push('wireframe')
  if (m.depthWrite === false) parts.push('depthWrite false')
  if (m.sizeAttenuation === false) parts.push('sizeAttenuation false')
  for (const slot of TEXTURE_SLOTS) if (isTexture(m[slot])) parts.push(`${slot} ${textureUrl(m[slot] as Texture)}`)
  if (m.vertexShader || m.fragmentShader) parts.push('custom GLSL (see Shaders)')
  const patch = m.onBeforeCompile?.toString() ?? ''
  if (patch && !/\{\s*\}\s*$/.test(patch)) parts.push(`shader patched in JavaScript with onBeforeCompile:\n\`\`\`js\n${truncateText(patch, MAX_PATCH_CHARS)}\n\`\`\``)
  const uniforms = Object.keys(m.uniforms ?? {}).filter((u) => animated.has(`${m.uuid}|uniform|${u}`))
  if (uniforms.length) parts.push(`animated uniforms: ${uniforms.join(', ')}`)
  return parts.join(' · ')
}

function geometryText(g: Geometry): string {
  const params = Object.entries(g.parameters ?? {})
    .filter(([, v]) => ['number', 'string', 'boolean'].includes(typeof v))
    .map(([k, v]) => `${k}: ${literal(v)}`)
  const vertices = g.attributes?.position?.count
  return `${g.type}${params.length ? `(${params.join(', ')})` : ''}${vertices ? ` ${vertices} vertices` : ''}`
}

function transformText(o: Object3D): string {
  const parts: string[] = []
  if (o.position.x || o.position.y || o.position.z) parts.push(`position ${vec(o.position)}`)
  if (o.rotation.x || o.rotation.y || o.rotation.z) parts.push(`rotation ${vec({ x: o.rotation.x, y: o.rotation.y, z: o.rotation.z })}`)
  if (o.scale.x !== 1 || o.scale.y !== 1 || o.scale.z !== 1) parts.push(`scale ${vec(o.scale)}`)
  return parts.join(' ')
}

function sceneLine(scene: Object3D): string {
  const parts = [`${scene.type}${scene.name ? ` "${scene.name}"` : ''}`]
  if (isColor(scene.background)) parts.push(`background ${colorHex(scene.background)}`)
  else if (isTexture(scene.background)) parts.push(`background texture ${textureUrl(scene.background)}`)
  if (isTexture(scene.environment)) parts.push(`environment ${textureUrl(scene.environment)}`)
  if (scene.fog) {
    const f = scene.fog
    parts.push(f.density !== undefined ? `FogExp2 ${colorHex(f.color)} density ${f.density}` : `Fog ${colorHex(f.color)} ${f.near}→${f.far}`)
  }
  if (scene.animations?.length) parts.push(`animation clips: ${scene.animations.map((a) => `"${a.name}" ${round(a.duration)}s`).join(', ')}`)
  return parts.join(' · ')
}

function cameraText(c: Object3D, animated?: string): string {
  const parts = [c.type]
  if (c.fov !== undefined) parts.push(`fov ${round(c.fov)}`, `aspect ${round(c.aspect ?? 1)}`)
  if (c.left !== undefined) parts.push(`frustum left ${round(c.left)} right ${round(c.right!)} top ${round(c.top!)} bottom ${round(c.bottom!)}`)
  parts.push(`near ${c.near}`, `far ${c.far}`)
  if (c.zoom !== undefined && c.zoom !== 1) parts.push(`zoom ${round(c.zoom)}`)
  parts.push(`position ${vec(c.position)}`, `rotation ${vec({ x: c.rotation.x, y: c.rotation.y, z: c.rotation.z })}`)
  if (animated) parts.push(`animating: ${animated}`)
  return parts.join(' · ')
}

// A color read as raw r/g/b, which three.js r152+ keeps in linear space (color management is on by
// default), as the sRGB hex the page's code set.
function linearHex(c: Color, revision: number): string {
  if (revision < 152) return hex(c.r, c.g, c.b)
  const srgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
  return hex(srgb(c.r), srgb(c.g), srgb(c.b))
}

function rendererSettings(r: Renderer, state: HookState, revision: number): string[] {
  const canvas = r.domElement
  const lines = [`canvas drawing buffer ${canvas.width}×${canvas.height}${r.getPixelRatio ? `, pixel ratio ${round(r.getPixelRatio())}` : ''}`]
  if (r.toneMapping !== undefined) lines.push(`tone mapping ${TONE_MAPPING[r.toneMapping] ?? r.toneMapping}ToneMapping, exposure ${round(r.toneMappingExposure ?? 1)}`)
  if (r.outputColorSpace) lines.push(`output color space "${r.outputColorSpace}"`)
  else if (r.outputEncoding !== undefined) lines.push(`output encoding ${r.outputEncoding === 3001 ? 'sRGBEncoding' : 'LinearEncoding'}`)
  if (r.getClearColor) {
    try {
      const c = { r: 0, g: 0, b: 0, isColor: true, copy(from: Color) { Object.assign(this, { r: from.r, g: from.g, b: from.b }); return this } }
      r.getClearColor(c)
      lines.push(`clear color ${linearHex(c, revision)}, alpha ${round(r.getClearAlpha?.() ?? 1)}`)
    } catch {
      // not a WebGLRenderer
    }
  }
  if (r.shadowMap) lines.push(`shadows ${r.shadowMap.enabled ? `${SHADOW_TYPES[r.shadowMap.type] ?? r.shadowMap.type}ShadowMap` : 'off'}`)
  const ctx = state.contexts.get(canvas)
  if (ctx) lines.push(`context ${ctx.type} ${literal(ctx.attributes ?? {})}`)
  return lines
}

function countVertices(scene: Object3D): number {
  let n = 0
  walk(scene, (o) => (n += o.geometry?.attributes?.position?.count ?? 0))
  return n
}

function countObjects(scene: Object3D): number {
  let n = 0
  walk(scene, () => n++)
  return n
}

// Texture files the page's scripts fetched (GLTF and ImageBitmap loaders keep no URL on the texture).
function fetchedTextures(): string[] {
  return performance
    .getEntriesByType('resource')
    .filter((e) => (e as PerformanceResourceTiming).initiatorType !== 'img' && IMAGE_FILE_RE.test(e.name))
    .map((e) => e.name)
    .slice(0, 40)
}

function exportScene(scene: Object3D): { json?: string; error?: string } {
  const vertices = countVertices(scene)
  if (vertices > MAX_JSON_VERTICES) return { error: `the scene has ${vertices} vertices, too many to export as JSON` }
  try {
    const json = JSON.stringify(scene.toJSON?.())
    if (!json) return { error: 'the scene has no toJSON method' }
    if (json.length > MAX_JSON_CHARS) return { error: `the scene JSON is ${Math.round(json.length / 1e6)} MB, too large to include` }
    return { json }
  } catch (err) {
    return { error: `three.js couldn't serialize the scene (${err instanceof Error ? err.message : String(err)})` }
  }
}

export interface ThreeSession {
  finish(): ThreeData
}

// Starts sampling a renderer's scenes; finish() (after a short wait) describes them.
export function beginThree(renderer: Renderer, state: HookState): ThreeSession {
  const revision = (window as Window & { __THREE__?: string }).__THREE__
  const rendered = (state.scenes.get(renderer) ?? [])
    .map((s) => ({ scene: s.scene.deref() as Object3D | undefined, camera: s.camera.deref() as Object3D | undefined }))
    .filter((s): s is { scene: Object3D; camera: Object3D } => !!s.scene && !!s.camera)
  const sizes = rendered.map((r) => countObjects(r.scene))
  const mainIndex = sizes.indexOf(Math.max(...sizes))
  const main = rendered[mainIndex]
  const passes = rendered.filter((_, i) => i !== mainIndex)

  const materials: Material[] = []
  const seen = new Set<string>()
  if (main) {
    walk(main.scene, (o) => {
      for (const m of materialsOf(o)) {
        if (seen.has(m.uuid)) continue
        seen.add(m.uuid)
        materials.push(m)
      }
    })
  }
  const passMaterials = passes.flatMap((p) => {
    const found: Material[] = []
    walk(p.scene, (o) => found.push(...materialsOf(o)))
    return found
  })
  const before = main ? sample(main.scene, main.camera, [...materials, ...passMaterials]) : new Map()
  const started = performance.now()

  return {
    finish() {
      const base: ThreeData = {
        target: label(renderer.domElement),
        revision: revision ? `r${revision}` : undefined,
        renderer: rendererSettings(renderer, state, Number(revision) || 0),
        scene: [],
        materials: [],
        shaders: [],
        postprocessing: [],
        textures: [],
      }
      if (!main) return base

      const after = sample(main.scene, main.camera, [...materials, ...passMaterials])
      const animated = rates(before, after, Math.max(0.05, (performance.now() - started) / 1000))
      const materialIndex = new Map(materials.map((m, i) => [m.uuid, i + 1]))

      const scene: string[] = [sceneLine(main.scene)]
      walk(main.scene, (o, depth) => {
        if (depth === 0) return
        if (scene.length === MAX_OUTLINE_LINES) scene.push('… more objects (see the scene JSON)')
        if (scene.length > MAX_OUTLINE_LINES) return
        const parts = [`${o.type}${o.name ? ` "${o.name}"` : ''}`]
        if (!o.visible) parts.push('hidden')
        if (o.geometry) parts.push(geometryText(o.geometry))
        if (o.type === 'InstancedMesh' && o.count !== undefined) parts.push(`${o.count} instances`)
        const mats = materialsOf(o)
        if (mats.length) parts.push(mats.map((m) => `material #${materialIndex.get(m.uuid)}`).join(' + '))
        if (o.isLight) {
          if (isColor(o.color)) parts.push(`color ${colorHex(o.color)}`)
          if (o.intensity !== undefined) parts.push(`intensity ${round(o.intensity)}`)
          if (o.castShadow) parts.push('castShadow')
        }
        const transform = transformText(o)
        if (transform) parts.push(transform)
        const motion = animated.get(o.uuid)
        if (motion) parts.push(`animating: ${motion}`)
        scene.push(`${'  '.repeat(depth - 1)}- ${parts.join(' · ')}`)
      })

      const textures = new Set<string>()
      for (const m of [...materials, ...passMaterials]) {
        for (const slot of TEXTURE_SLOTS) if (isTexture(m[slot])) textures.add(textureUrl(m[slot] as Texture))
        for (const { value } of Object.values(m.uniforms ?? {})) if (isTexture(value)) textures.add(textureUrl(value))
      }
      if (isTexture(main.scene.background)) textures.add(textureUrl(main.scene.background))
      if (isTexture(main.scene.environment)) textures.add(textureUrl(main.scene.environment))
      for (const url of [...(state.textures.get(renderer.domElement) ?? []), ...fetchedTextures()]) textures.add(url)

      const { json, error } = exportScene(main.scene)
      return {
        ...base,
        camera: cameraText(main.camera, animated.get('camera')),
        scene,
        materials: materials.map((m, i) => materialText(m, i + 1, animated)),
        shaders: materials
          .filter((m) => m.vertexShader || m.fragmentShader)
          .map((m) => shaderOf(m, `material #${materialIndex.get(m.uuid)} ${m.type}${m.name ? ` "${m.name}"` : ''}`, animated)),
        postprocessing: passMaterials
          .filter((m) => m.fragmentShader)
          .map((m, i) => shaderOf(m, `pass ${i + 1}: ${m.name || m.type}`, animated)),
        textures: Array.from(textures).filter((t) => !t.startsWith('(texture)')),
        sceneJson: json,
        sceneJsonError: error,
      }
    },
  }
}
