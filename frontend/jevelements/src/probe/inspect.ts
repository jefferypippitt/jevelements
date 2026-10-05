// Answers the content script's "jev:inspect": everything the page's JavaScript knows about the marked
// section. three.js scenes and raw WebGL uniforms are sampled over a short window to see what animates.
import type { LottieData, RuntimeData, WebGLData } from '../shared/types'
import { label } from '../shared/dom'
import { PROBE_ROOT_ATTR } from '../shared/runtime'
import { literal, round } from './format'
import { describeGsap } from './gsap'
import type { HookState, UniformRecord } from './hooks'
import { detectLibraries } from './libraries'
import { markInteractive } from './listeners'
import { beginThree, type ThreeSession } from './three'

const SAMPLE_MS = 600
const MAX_LOTTIE_JSON = 5_000_000

interface LottieAnimation {
  wrapper?: Element
  animationData?: { w?: number; h?: number; fr?: number; ip?: number; op?: number }
  renderer?: { rendererType?: string }
  loop?: boolean | number
  autoplay?: boolean
  playSpeed?: number
  frameRate?: number
  totalFrames?: number
  path?: string
  fileName?: string
}

function describeLottie(root: Element): LottieData[] {
  const w = window as Window & { lottie?: { getRegisteredAnimations?: () => LottieAnimation[] }; bodymovin?: { getRegisteredAnimations?: () => LottieAnimation[] } }
  const animations = (w.lottie ?? w.bodymovin)?.getRegisteredAnimations?.() ?? []
  return animations
    .filter((a) => a.wrapper instanceof Element && (a.wrapper === root || root.contains(a.wrapper)))
    .map((a) => {
      const d = a.animationData ?? {}
      const settings = [
        `renderer ${a.renderer?.rendererType ?? 'svg'}`,
        `loop ${a.loop ?? true}`,
        `autoplay ${a.autoplay ?? true}`,
        `speed ${a.playSpeed ?? 1}`,
        `${a.frameRate ?? d.fr ?? '?'} fps`,
        `${a.totalFrames ?? (d.op !== undefined && d.ip !== undefined ? d.op - d.ip : '?')} frames`,
        d.w && d.h ? `${d.w}×${d.h}` : '',
      ].filter(Boolean)
      let url: string | undefined
      if (a.path && a.fileName) {
        try {
          url = new URL(`${a.path}${a.fileName}.json`, location.href).href
        } catch {
          // relative path without a base
        }
      }
      let json: string | undefined
      try {
        const text = a.animationData ? JSON.stringify(a.animationData) : ''
        if (text && text.length <= MAX_LOTTIE_JSON) json = text
      } catch {
        // circular or exotic data
      }
      return { target: label(a.wrapper!), settings: settings.join(', '), url, json }
    })
}

// Lenis's own defaults, left out so only the page's choices show.
const LENIS_DEFAULTS: Record<string, unknown> = {
  smoothWheel: true,
  syncTouch: false,
  syncTouchLerp: 0.075,
  touchInertiaMultiplier: 35,
  touchInertiaExponent: 1.7,
  infinite: false,
  gestureOrientation: 'vertical',
  orientation: 'vertical',
  touchMultiplier: 1,
  wheelMultiplier: 1,
  autoResize: true,
  overscroll: true,
  autoRaf: false,
  anchors: false,
  autoToggle: false,
  allowNestedScroll: false,
  prevent: undefined,
  virtualScroll: undefined,
}

function describeSmoothScroll(): string | undefined {
  const w = window as Window & { lenis?: { options?: Record<string, unknown> }; LocomotiveScroll?: unknown }
  const options = w.lenis?.options
  if (options) {
    const chosen = Object.entries(options).filter(
      ([k, v]) => !k.startsWith('_') && ['number', 'string', 'boolean', 'function'].includes(typeof v) && !(k in LENIS_DEFAULTS && LENIS_DEFAULTS[k] === v),
    )
    return `Lenis ${literal(Object.fromEntries(chosen))} (every other option at its default)`
  }
  if (document.documentElement.classList.contains('lenis')) return 'Lenis (its options are not readable: the instance is not on window)'
  if (w.LocomotiveScroll || document.querySelector('[data-scroll-container]')) return 'Locomotive Scroll'
  return undefined
}

function uniformLines(canvas: HTMLCanvasElement, state: HookState, before: Map<string, UniformRecord>, seconds: number): string[] {
  return Array.from(state.uniforms.get(canvas) ?? [], ([name, rec]) => {
    const value = rec.value.length === 1 ? String(round(rec.value[0])) : `(${rec.value.map((v) => round(v)).join(', ')})`
    const prev = before.get(name)
    let motion = ''
    if (prev && rec.updates > prev.updates && rec.value.some((v, i) => v !== prev.value[i])) {
      const rate = (rec.value[0] - prev.value[0]) / seconds
      motion = rec.value.length === 1 ? `  (animating: ${rate > 0 ? '+' : ''}${round(rate)}/s)` : '  (changes every frame)'
    }
    return `${name}: ${value}${motion}`
  })
}

function describeWebGL(canvas: HTMLCanvasElement, state: HookState, before: Map<string, UniformRecord>, seconds: number): WebGLData {
  const ctx = state.contexts.get(canvas)
  const uniforms = uniformLines(canvas, state, before, seconds)
  const programs = Array.from(state.programs.get(canvas)?.values() ?? [])
  const uses = (source: string, line: string) => new RegExp(`\\b${line.split(/[:[]/)[0].trim()}\\b`).test(source)
  return {
    target: label(canvas),
    context: ctx ? `${ctx.type} ${literal(ctx.attributes ?? {})}` : 'unknown (the context was created before the probe loaded)',
    programs: programs.map((p, i) => ({
      name: `program ${i + 1}`,
      vertex: p.vertex,
      fragment: p.fragment,
      uniforms: programs.length === 1 ? uniforms : uniforms.filter((u) => uses(p.vertex, u) || uses(p.fragment, u)),
    })),
    textures: Array.from(state.textures.get(canvas) ?? []),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function inspectRuntime(state: HookState): Promise<RuntimeData> {
  const root = document.querySelector(`[${PROBE_ROOT_ATTR}]`) ?? document.documentElement
  const canvases = [root, ...Array.from(root.querySelectorAll('canvas'))].filter((c): c is HTMLCanvasElement => c instanceof HTMLCanvasElement)
  const inRoot = (el: Element) => el === root || root.contains(el)

  const renderers = Array.from(new Set(state.renderers.map((r) => r.deref()))).filter((r) => r && inRoot(r.domElement))
  const sessions: ThreeSession[] = renderers.map((r) => beginThree(r!, state))
  const rawCanvases = canvases.filter((c) => !state.threeCanvases.has(c) && (state.contexts.has(c) || state.programs.has(c)))
  const before = new Map(rawCanvases.map((c) => [c, new Map(Array.from(state.uniforms.get(c) ?? [], ([k, v]) => [k, { ...v }]))]))
  const started = performance.now()
  if (sessions.length || rawCanvases.length) await sleep(SAMPLE_MS)
  const seconds = Math.max(0.05, (performance.now() - started) / 1000)
  markInteractive(root)

  return {
    libraries: detectLibraries(),
    three: sessions.map((s) => s.finish()),
    webgl: rawCanvases.map((c) => describeWebGL(c, state, before.get(c) ?? new Map(), seconds)),
    gsap: describeGsap(root, canvases.length > 0),
    lottie: describeLottie(root),
    smoothScroll: describeSmoothScroll(),
    lateProbe: state.late,
    workers: state.workers,
    offscreen: canvases.filter((c) => state.offscreen.has(c)).map(label),
  }
}
