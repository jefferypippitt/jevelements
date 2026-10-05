// Reads GSAP's live timelines: every tween that animates something inside the section, the timelines
// that hold them, and their ScrollTriggers, written back as GSAP calls the clone can reuse.
import type { GsapData, GsapScrollTrigger, GsapTimeline, GsapTween } from '../shared/types'
import { label } from '../shared/dom'
import { literal, round } from './format'

const MAX_TWEENS = 80
const MAX_TRIGGERS = 30
const OMITTED_VARS = new Set(['runBackwards', 'immediateRender', 'startAt', 'parent', 'lazy', 'callbackScope'])
const DEFAULT_DURATION = 0.5
// Values GSAP fills in itself; writing them out only adds noise.
const DEFAULT_VARS: Record<string, unknown> = { overwrite: false, delay: 0, anticipatePin: 0, duration: DEFAULT_DURATION }

interface Animation {
  vars: Record<string, unknown>
  parent?: Animation | null
  duration(): number
  startTime(): number
  targets?: () => unknown[]
  getChildren?: (nested: boolean, tweens: boolean, timelines: boolean) => Animation[]
}

interface Gsap {
  version?: string
  globalTimeline: Animation
}

interface Trigger {
  trigger?: unknown
  vars: Record<string, unknown>
  start: number
  end: number
  animation?: Animation
}

function pick(vars: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(vars)) {
    if (OMITTED_VARS.has(k) || (k in DEFAULT_VARS && DEFAULT_VARS[k] === v)) continue
    out[k] = k === 'scrollTrigger' ? '(see ScrollTriggers)' : v
  }
  return { ...out, ...extra }
}

function targetList(targets: unknown[], inSection: (t: unknown) => boolean): string {
  const shown = targets.filter(inSection).slice(0, 12)
  const names = shown.map((t) => (t instanceof Element ? JSON.stringify(label(t)) : `/* object { ${Object.keys(t as object).slice(0, 6).join(', ')} } */`))
  const others = targets.length - shown.length
  if (names.length === 1 && others <= 0) return names[0]
  return `[${names.join(', ')}${others > 0 ? `, /* +${others} more targets */` : ''}]`
}

function tweenCode(t: Animation, inSection: (t: unknown) => boolean): string {
  const targets = targetList(t.targets?.() ?? [], inSection)
  const extra = t.vars.duration === undefined && t.duration() > 0 && t.duration() !== DEFAULT_DURATION ? { duration: round(t.duration()) } : {}
  const vars = literal(pick(t.vars, extra))
  if (t.vars.startAt) return `gsap.fromTo(${targets}, ${literal(t.vars.startAt)}, ${vars})`
  if (t.vars.runBackwards) return `gsap.from(${targets}, ${vars})`
  return `gsap.${t.duration() === 0 ? 'set' : 'to'}(${targets}, ${vars})`
}

export function describeGsap(root: Element, includeObjects: boolean): GsapData | undefined {
  const w = window as Window & { gsap?: Gsap; ScrollTrigger?: { getAll?: () => Trigger[] } }
  const gsap = w.gsap
  if (!gsap?.globalTimeline?.getChildren) {
    // Bundled GSAP has no global, but it tags every element it animates.
    const tagged = '_gsap' in root || Array.from(root.querySelectorAll('*')).slice(0, 3000).some((el) => '_gsap' in el)
    return tagged ? { tweens: [], timelines: [], scrollTriggers: [], bundled: true } : undefined
  }

  const inSection = (t: unknown) =>
    t instanceof Element ? t === root || root.contains(t) : includeObjects && !!t && typeof t === 'object' && !(t instanceof Node)
  const global = gsap.globalTimeline
  const all = global.getChildren!(true, true, true)
  const tweens = all.filter((a) => a.targets && a.targets().some(inSection)).slice(0, MAX_TWEENS)

  const timelines = new Set<Animation>()
  const addParents = (a: Animation) => {
    for (let p = a.parent; p && p !== global; p = p.parent) timelines.add(p)
  }
  tweens.forEach(addParents)

  const triggers = (w.ScrollTrigger?.getAll?.() ?? [])
    .filter((st) => {
      const el = st.trigger
      const near =
        el instanceof Element && (root.contains(el) || (el.contains(root) && el !== document.body && el !== document.documentElement))
      const drives = !!st.animation && (tweens.includes(st.animation) || timelines.has(st.animation))
      return near || drives
    })
    .slice(0, MAX_TRIGGERS)
  for (const st of triggers) {
    if (!st.animation) continue
    if (st.animation.getChildren) timelines.add(st.animation)
    addParents(st.animation)
  }

  // Ids follow GSAP's own order (parents before children).
  const ordered = [...all.filter((a) => timelines.has(a) || tweens.includes(a))]
  for (const t of timelines) if (!ordered.includes(t)) ordered.unshift(t)
  const ids = new Map(ordered.map((a, i) => [a, i + 1]))
  const parentId = (a: Animation) => (a.parent && a.parent !== global ? ids.get(a.parent) : undefined)

  const timelineData: GsapTimeline[] = ordered
    .filter((a) => timelines.has(a))
    .map((tl) => ({
      id: ids.get(tl)!,
      code: `gsap.timeline(${literal(pick(tl.vars))})`,
      duration: round(tl.duration()),
      timeline: parentId(tl),
      start: round(tl.startTime()),
    }))
  const tweenData: GsapTween[] = tweens.map((t) => ({
    id: ids.get(t)!,
    code: tweenCode(t, inSection),
    timeline: parentId(t),
    start: round(t.startTime()),
  }))
  const triggerData: GsapScrollTrigger[] = triggers.map((st) => {
    const config: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(st.vars)) {
      if (k === 'trigger' || k === 'animation' || (k in DEFAULT_VARS && DEFAULT_VARS[k] === v)) continue
      if (k === 'toggleActions' && (st.vars.scrub || v === 'play' || v === 'play none none none')) continue // ignored with scrub; else the default
      config[k] = v
    }
    return {
      trigger: st.trigger instanceof Element ? label(st.trigger) : '(none)',
      config: literal(config),
      range: `page scroll ${Math.round(st.start)}px → ${Math.round(st.end)}px`,
      animation: st.animation ? ids.get(st.animation) : undefined,
    }
  })

  return { version: gsap.version, tweens: tweenData, timelines: timelineData, scrollTriggers: triggerData, bundled: false }
}
