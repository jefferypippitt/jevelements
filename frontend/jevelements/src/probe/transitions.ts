// Page transitions are not inside the captured section: they run while one page replaces another.
// Barba and Swup keep the leave/enter functions on the instance, and the View Transition API names
// the elements that travel. Recording those is what makes a stairs, pixel, or parallel transition
// rebuildable. The next page's DOM is still the other page; this is the animation between them.
import { label } from '../shared/dom'
import type { PageTransition } from '../shared/types'
import { literal } from './format'

const MAX_CODE = 1500
const MAX_NAMES = 24

interface Registered {
  library: string
  options: Record<string, unknown>
}

const registered: Registered[] = []
const played: PageTransition[] = []

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function sourceOf(fn: unknown): string | undefined {
  if (typeof fn !== 'function') return undefined
  const text = Function.prototype.toString.call(fn)
  if (text.includes('[native code]') || text.length < 8) return undefined
  return text.length > MAX_CODE ? `${text.slice(0, MAX_CODE)}\n/* … */` : text
}

function watchGlobal(name: string, onSet: (value: object) => void) {
  const host = window as unknown as Record<string, unknown>
  let current = host[name]
  if (isObject(current)) onSet(current)
  const existing = Object.getOwnPropertyDescriptor(window, name)
  if (existing && !existing.configurable) return
  try {
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value: unknown) => {
        current = value
        if (isObject(value)) onSet(value)
      },
    })
  } catch {
    // The page already owns this property.
  }
}

function rememberBarba(options: unknown) {
  if (!isObject(options) || !('transitions' in options)) return
  const list = options.transitions
  const items = Array.isArray(list) ? list : [list]
  for (const item of items) if (isObject(item)) registered.push({ library: 'Barba.js', options: item })
}

function wrapBarba(barba: object) {
  const host = barba as { init?: (this: unknown, ...args: unknown[]) => unknown }
  const init = host.init
  if (typeof init !== 'function' || (init as { __jev?: boolean }).__jev) return
  const wrapped = function (this: unknown, ...args: unknown[]) {
    rememberBarba(args[0])
    return init.apply(this, args)
  }
  Object.defineProperty(wrapped, '__jev', { value: true })
  host.init = wrapped
}

function hookViewTransitions() {
  const proto = Document.prototype as Document & { startViewTransition?: (callback?: () => unknown) => unknown }
  const native = proto.startViewTransition
  if (typeof native !== 'function' || (native as { __jev?: boolean }).__jev) return
  const wrapped = function (this: Document, callback?: () => unknown) {
    const source = sourceOf(callback)
    played.push({
      library: 'View Transition API',
      summary: 'document.startViewTransition ran on this page.',
      steps: [],
      code: source ? [{ label: 'callback', source }] : undefined,
    })
    return native.call(this, callback)
  }
  Object.defineProperty(wrapped, '__jev', { value: true })
  proto.startViewTransition = wrapped as Document['startViewTransition']
}

export function installTransitionHooks() {
  watchGlobal('barba', wrapBarba)
  hookViewTransitions()
}

function endpoint(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'function') return 'a custom match'
  if (!isObject(value)) return undefined
  const namespace = value.namespace
  if (typeof namespace === 'string') return `namespace ${namespace}`
  if (Array.isArray(namespace)) return `namespace ${namespace.map((item) => String(item)).join(', ')}`
  return undefined
}

function looksLikeTransition(value: Record<string, unknown>): boolean {
  const hasStep = typeof value.leave === 'function' || typeof value.enter === 'function' || typeof value.once === 'function'
  const named = 'name' in value || 'from' in value || 'to' in value || 'sync' in value
  return hasStep && named
}

function harvest(value: unknown, library: string, into: Registered[], seen: WeakSet<object>, depth = 0) {
  if (!isObject(value) || value instanceof Node || seen.has(value) || depth > 2) return
  seen.add(value)
  if (looksLikeTransition(value)) {
    into.push({ library, options: value })
    return
  }
  const children = Object.values(value)
  if (children.length > 40) return
  for (const child of children) harvest(child, library, into, seen, depth + 1)
}

function describeRegistered(item: Registered): PageTransition | null {
  const options = item.options
  const name = typeof options.name === 'string' ? options.name : undefined
  const from = endpoint(options.from)
  const to = endpoint(options.to)
  const parallel = options.sync === true
  const route = [from ? `from ${from}` : '', to ? `to ${to}` : ''].filter(Boolean).join(' → ')
  const summary = [
    name ? `"${name}"` : 'unnamed transition',
    route,
    parallel ? 'parallel (sync: true): the outgoing and incoming pages animate together' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const code: { label: string; source: string }[] = []
  for (const step of ['leave', 'enter', 'once'] as const) {
    const source = sourceOf(options[step])
    if (source) code.push({ label: step, source })
  }
  if (!code.length && summary === 'unnamed transition') return null
  return { library: item.library, summary, steps: [], code: code.length ? code : undefined }
}

function viewNames(root: Element): string[] {
  const names: string[] = []
  const nodes = [root, ...Array.from(root.querySelectorAll('*')).slice(0, 2000)]
  for (const el of nodes) {
    if (names.length >= MAX_NAMES) break
    let name: string
    try {
      name = getComputedStyle(el).getPropertyValue('view-transition-name')
    } catch {
      continue
    }
    if (name && name !== 'none') names.push(`\`${label(el)}\`: ${name}`)
  }
  return names
}

function viewTransitionRules(): string[] {
  const rules: string[] = []
  for (const sheet of Array.from(document.styleSheets).slice(0, 30)) {
    let css: CSSRuleList
    try {
      css = sheet.cssRules
    } catch {
      continue
    }
    let examined = 0
    for (const rule of Array.from(css)) {
      if (++examined > 400) return rules
      if (!rule.cssText.includes('@view-transition') && !rule.cssText.includes('::view-transition')) continue
      rules.push(rule.cssText.length > 500 ? `${rule.cssText.slice(0, 500)}…` : rule.cssText)
      if (rules.length >= 8) return rules
    }
  }
  return rules
}

function swupTransition(): PageTransition | null {
  const swup = (window as unknown as { swup?: { options?: { animationSelector?: unknown } } }).swup
  const selector = swup?.options?.animationSelector
  if (!selector) return null
  return {
    library: 'Swup',
    summary: `page swaps use the animation selector ${literal(selector)}. The transition classes are the site's CSS.`,
    steps: [],
  }
}

export function describeTransitions(root: Element): PageTransition[] {
  const harvested: Registered[] = [...registered]
  const barba = (window as unknown as { barba?: object }).barba
  if (barba) harvest(barba, 'Barba.js', harvested, new WeakSet())
  const described = harvested.map(describeRegistered).filter((item): item is PageTransition => !!item)
  const swup = swupTransition()
  if (swup) described.push(swup)
  described.push(...played)
  const names = viewNames(root)
  const rules = viewTransitionRules()
  if (names.length || rules.length) {
    described.push({
      library: 'View Transition API',
      summary: 'Elements that keep their identity across a navigation. Animate them with the same view-transition-name.',
      steps: [...names, ...rules],
    })
  }
  const seen = new Set<string>()
  return described.filter((item) => {
    const key = `${item.library}|${item.summary}|${item.code?.map((entry) => entry.source).join('\n') ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 6)
}
