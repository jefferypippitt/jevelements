// Hooks installed at document_start, before the page's scripts run. They record what can't be read
// back later: which scenes three.js renders (via the __THREE_DEVTOOLS__ hook three.js itself calls,
// the same one the three.js devtools extension uses), the GLSL sources and image textures handed to
// WebGL, and the WGSL handed to WebGPU. Each hook only stores references, so pages pay next to
// nothing for them.
import { installPhysicsHooks } from './physics'
import { installTransitionHooks } from './transitions'

const MAX_PROGRAMS_PER_CANVAS = 30
const MAX_WGSL_PER_DEVICE = 30
const MAX_TEXTURES_PER_CANVAS = 40
const MAX_SCENES_PER_RENDERER = 6

type Canvas = HTMLCanvasElement | OffscreenCanvas

// The parts of a three.js WebGLRenderer the probe touches.
export interface ThreeRenderer {
  isWebGLRenderer?: boolean
  domElement: HTMLCanvasElement
  render: (scene: object, camera: object) => void
}

export interface RenderedScene {
  scene: WeakRef<object>
  camera: WeakRef<object>
}

// The last value a raw WebGL program set for a uniform, and how often it was set.
export interface UniformRecord {
  value: number[]
  updates: number
}

export interface HookState {
  late: boolean // installed after the page had loaded
  renderers: WeakRef<ThreeRenderer>[]
  threeCanvases: WeakSet<HTMLCanvasElement>
  scenes: WeakMap<ThreeRenderer, RenderedScene[]>
  programs: WeakMap<Canvas, Map<string, { vertex: string; fragment: string }>>
  textures: WeakMap<Canvas, Set<string>>
  contexts: WeakMap<Canvas, { type: string; attributes: WebGLContextAttributes | null }>
  uniforms: WeakMap<Canvas, Map<string, UniformRecord>>
  devices: WeakMap<Canvas, object> // the GPUDevice a WebGPU canvas was configured with
  wgsl: WeakMap<object, string[]> // GPUDevice → the WGSL of its shader modules, in creation order
  workers: string[] // script URLs of the Web Workers the page started
  offscreen: WeakSet<HTMLCanvasElement> // canvases handed to a worker with transferControlToOffscreen
}

export function installHooks(late: boolean): HookState {
  const state: HookState = {
    late,
    renderers: [],
    threeCanvases: new WeakSet(),
    scenes: new WeakMap(),
    programs: new WeakMap(),
    textures: new WeakMap(),
    contexts: new WeakMap(),
    uniforms: new WeakMap(),
    devices: new WeakMap(),
    wgsl: new WeakMap(),
    workers: [],
    offscreen: new WeakSet(),
  }
  hookThree(state)
  hookWebGL(state)
  hookWebGPU(state)
  hookWorkers(state)
  installPhysicsHooks()
  installTransitionHooks()
  return state
}

// A canvas handed to a Web Worker draws off the main thread, where the WebGL hooks can't see it. Noting
// the worker scripts and those canvases lets the content script look for that code in the page's
// scripts instead (content/code.ts). Both wrappers pass everything through unchanged.
function hookWorkers(state: HookState) {
  const NativeWorker = window.Worker
  if (NativeWorker) {
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        try {
          const url = new URL(String(args[0]), location.href).href
          if (state.workers.length < 20 && !state.workers.includes(url)) state.workers.push(url)
        } catch {
          // not a URL we can record
        }
        return Reflect.construct(target, args, newTarget) as Worker
      },
    })
  }
  const transfer = HTMLCanvasElement.prototype.transferControlToOffscreen
  if (transfer) {
    HTMLCanvasElement.prototype.transferControlToOffscreen = function (this: HTMLCanvasElement) {
      state.offscreen.add(this)
      return transfer.call(this)
    }
  }
}

function hookThree(state: HookState) {
  const w = window as Window & { __THREE_DEVTOOLS__?: EventTarget }
  let target = w.__THREE_DEVTOOLS__
  if (!target) {
    target = new EventTarget()
    try {
      Object.defineProperty(window, '__THREE_DEVTOOLS__', { value: target, configurable: true, writable: true })
    } catch {
      return
    }
  }
  target.addEventListener('observe', (e) => {
    const obj = (e as CustomEvent<unknown>).detail as Partial<ThreeRenderer> | null
    if (!obj || typeof obj.render !== 'function' || !(obj.domElement instanceof HTMLCanvasElement)) return
    const renderer = obj as ThreeRenderer
    state.renderers.push(new WeakRef(renderer))
    state.threeCanvases.add(renderer.domElement)
    const render = renderer.render
    // Post-processing renders several scenes per frame (the main one, then full-screen passes), so keep
    // each distinct scene this renderer draws.
    renderer.render = function (this: ThreeRenderer, scene: object, camera: object) {
      const seen = state.scenes.get(renderer) ?? []
      const known = seen.find((s) => s.scene.deref() === scene)
      if (known) known.camera = new WeakRef(camera)
      else if (seen.length < MAX_SCENES_PER_RENDERER && scene && camera) {
        seen.push({ scene: new WeakRef(scene), camera: new WeakRef(camera) })
        state.scenes.set(renderer, seen)
      }
      return render.call(this, scene, camera)
    }
  })
}

const UNIFORM_SETTERS = [
  'uniform1f', 'uniform2f', 'uniform3f', 'uniform4f',
  'uniform1i', 'uniform2i', 'uniform3i', 'uniform4i',
  'uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv',
  'uniform1iv', 'uniform2iv', 'uniform3iv', 'uniform4iv',
] as const
const MAX_UNIFORMS_PER_CANVAS = 80
const MAX_UNIFORM_VALUES = 16

function hookWebGL(state: HookState) {
  const shaderTypes = new WeakMap<WebGLShader, number>()
  const shaderSources = new WeakMap<WebGLShader, string>()
  const programShaders = new WeakMap<WebGLProgram, WebGLShader[]>()
  const uniformNames = new WeakMap<WebGLUniformLocation, string>()

  const getContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, options?: unknown) {
    const ctx = (getContext as (this: HTMLCanvasElement, type: string, options?: unknown) => RenderingContext | null).call(this, type, options)
    if (ctx && /webgl|webgpu/.test(type) && !state.contexts.has(this)) {
      state.contexts.set(this, { type, attributes: type === 'webgpu' ? null : ((ctx as WebGLRenderingContext).getContextAttributes?.() ?? null) })
    }
    return ctx
  } as typeof getContext

  const protos = [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype].filter(
    (p): p is WebGLRenderingContext | WebGL2RenderingContext => !!p,
  )
  for (const proto of protos) {
    const createShader = proto.createShader
    proto.createShader = function (this: WebGLRenderingContext, type: number) {
      const shader = createShader.call(this, type)
      if (shader) shaderTypes.set(shader, type)
      return shader
    }

    const shaderSource = proto.shaderSource
    proto.shaderSource = function (this: WebGLRenderingContext, shader: WebGLShader, source: string) {
      shaderSources.set(shader, source)
      return shaderSource.call(this, shader, source)
    }

    const attachShader = proto.attachShader
    proto.attachShader = function (this: WebGLRenderingContext, program: WebGLProgram, shader: WebGLShader) {
      const list = programShaders.get(program) ?? []
      list.push(shader)
      programShaders.set(program, list)
      return attachShader.call(this, program, shader)
    }

    const linkProgram = proto.linkProgram
    proto.linkProgram = function (this: WebGLRenderingContext, program: WebGLProgram) {
      const shaders = programShaders.get(program) ?? []
      const source = (type: number) => shaderSources.get(shaders.find((s) => shaderTypes.get(s) === type)!) ?? ''
      const vertex = source(this.VERTEX_SHADER)
      const fragment = source(this.FRAGMENT_SHADER)
      if (vertex || fragment) {
        const programs = state.programs.get(this.canvas) ?? new Map()
        if (programs.size < MAX_PROGRAMS_PER_CANVAS) programs.set(vertex + '\0' + fragment, { vertex, fragment })
        state.programs.set(this.canvas, programs)
      }
      return linkProgram.call(this, program)
    }

    // Uniform values of hand-written WebGL (three.js keeps its own, readable from its materials).
    const getUniformLocation = proto.getUniformLocation
    proto.getUniformLocation = function (this: WebGLRenderingContext, program: WebGLProgram, name: string) {
      const location = getUniformLocation.call(this, program, name)
      if (location && !(this.canvas instanceof HTMLCanvasElement && state.threeCanvases.has(this.canvas))) uniformNames.set(location, name)
      return location
    }
    for (const setter of UNIFORM_SETTERS) {
      const original = proto[setter] as (this: WebGLRenderingContext, ...args: unknown[]) => void
      ;(proto as unknown as Record<string, unknown>)[setter] = function (this: WebGLRenderingContext, ...args: unknown[]) {
        const name = args[0] ? uniformNames.get(args[0] as WebGLUniformLocation) : undefined
        if (name) {
          const uniforms = state.uniforms.get(this.canvas) ?? new Map<string, UniformRecord>()
          const record = uniforms.get(name)
          const rest = args.slice(1)
          const value = setter.endsWith('v') ? Array.from((rest[0] as ArrayLike<number>) ?? []).slice(0, MAX_UNIFORM_VALUES) : (rest as number[])
          if (record) {
            record.value = value
            record.updates++
          } else if (uniforms.size < MAX_UNIFORMS_PER_CANVAS) {
            uniforms.set(name, { value, updates: 1 })
            state.uniforms.set(this.canvas, uniforms)
          }
        }
        return original.apply(this, args)
      }
    }

    // texImage2D has several overloads; the image source, when there is one, is the last argument.
    const texImage2D = proto.texImage2D as (this: WebGLRenderingContext, ...args: unknown[]) => void
    proto.texImage2D = function (this: WebGLRenderingContext, ...args: unknown[]) {
      const source = args[args.length - 1]
      const url = source instanceof HTMLImageElement ? source.currentSrc || source.src : source instanceof HTMLVideoElement ? source.currentSrc : ''
      if (url) {
        const textures = state.textures.get(this.canvas) ?? new Set<string>()
        if (textures.size < MAX_TEXTURES_PER_CANVAS) textures.add(url)
        state.textures.set(this.canvas, textures)
      }
      return texImage2D.apply(this, args)
    } as typeof proto.texImage2D
  }
}

// WebGPU: configure() ties a canvas to a device, and the device compiles WGSL with
// createShaderModule. Recording both gives each WebGPU canvas its shader source.
interface GpuDeviceLike {
  createShaderModule: (descriptor: { code: string }) => unknown
}
interface GpuCanvasContextLike {
  canvas: Canvas
  configure: (config: { device: object }) => void
}

function hookWebGPU(state: HookState) {
  const w = window as unknown as { GPUDevice?: { prototype: GpuDeviceLike }; GPUCanvasContext?: { prototype: GpuCanvasContextLike } }
  const device = w.GPUDevice?.prototype
  if (device) {
    const createShaderModule = device.createShaderModule
    device.createShaderModule = function (this: object, descriptor: { code: string }) {
      const list = state.wgsl.get(this) ?? []
      if (typeof descriptor?.code === 'string' && list.length < MAX_WGSL_PER_DEVICE && !list.includes(descriptor.code)) list.push(descriptor.code)
      state.wgsl.set(this, list)
      return createShaderModule.call(this, descriptor)
    }
  }
  const context = w.GPUCanvasContext?.prototype
  if (context) {
    const configure = context.configure
    context.configure = function (this: GpuCanvasContextLike, config: { device: object }) {
      if (config?.device) state.devices.set(this.canvas, config.device)
      return configure.call(this, config)
    }
  }
}
