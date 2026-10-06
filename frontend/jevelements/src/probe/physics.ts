// Reads a live 2D/3D physics world the page is stepping: Matter.js, cannon/cannon-es, or Rapier.
// The solver's masses, shapes and constraints are not in the DOM, so the rebuild otherwise only
// sees a few sampled positions. Engines created after this probe loads are remembered by wrapping
// the library's constructor; engines a React component keeps in a ref are found on its fiber.
import { label } from '../shared/dom'
import type { PhysicsWorld } from '../shared/types'
import { round } from './format'

const MAX_WORLDS = 2
const MAX_BODIES = 32
const MAX_CONSTRAINTS = 16
const MATCH_PX = 20

interface Vec2 {
  x: number
  y: number
}
interface MatterBody {
  id: number
  label?: string
  position: Vec2
  velocity: Vec2
  angle: number
  mass?: number
  friction?: number
  restitution?: number
  isStatic?: boolean
  circleRadius?: number
  bounds?: { min: Vec2; max: Vec2 }
  parent?: MatterBody
  plugin?: Record<string, unknown>
  element?: unknown
}
interface MatterConstraint {
  label?: string
  bodyA?: MatterBody
  bodyB?: MatterBody
  length?: number
  stiffness?: number
}
interface MatterWorld {
  bodies: MatterBody[]
  constraints: MatterConstraint[]
  gravity?: Vec2 & { scale?: number }
}
interface MatterNs {
  Composite?: { allBodies?: (world: object) => MatterBody[] }
}

interface Fiber {
  memoizedState?: { memoizedState?: unknown; next?: Fiber['memoizedState'] } | null
  memoizedProps?: unknown
  stateNode?: unknown
  child?: Fiber | null
  sibling?: Fiber | null
  return?: Fiber | null
}

const found = new Set<object>()
let matterNs: MatterNs | undefined

function isObject(value: unknown): value is object {
  return !!value && typeof value === 'object'
}

function remember(value: unknown) {
  if (isObject(value)) found.add(value)
}

// Defining the property early lets a later `window.Matter = …` hit the setter before the page
// calls Engine.create. The value stays undefined until that assignment, so `if (window.Matter)`
// still means the library has loaded.
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

function wrapMethod(owner: object, key: string) {
  const host = owner as Record<string, unknown>
  const original = host[key]
  if (typeof original !== 'function' || (original as { __jev?: boolean }).__jev) return
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const result = (original as (this: unknown, ...a: unknown[]) => unknown).apply(this, args)
    remember(result)
    return result
  }
  Object.defineProperty(wrapped, '__jev', { value: true })
  host[key] = wrapped
}

function wrapConstructor(ns: object, key: string) {
  const host = ns as Record<string, unknown>
  const Original = host[key]
  if (typeof Original !== 'function' || (Original as { __jev?: boolean }).__jev) return
  const Wrapped = function (this: unknown, ...args: unknown[]) {
    const instance = Reflect.construct(Original as new (...a: unknown[]) => object, args, new.target as unknown as new (...a: unknown[]) => object)
    remember(instance)
    return instance
  }
  Object.setPrototypeOf(Wrapped, Original)
  Wrapped.prototype = Original.prototype
  Object.defineProperty(Wrapped, '__jev', { value: true })
  host[key] = Wrapped
}

function wrapMatter(ns: object) {
  matterNs = ns as MatterNs
  const engine = (ns as { Engine?: object }).Engine
  if (engine) wrapMethod(engine, 'create')
}

export function installPhysicsHooks() {
  watchGlobal('Matter', wrapMatter)
  watchGlobal('CANNON', (ns) => wrapConstructor(ns, 'World'))
  watchGlobal('RAPIER', (ns) => wrapConstructor(ns, 'World'))
}

function isMatterWorld(value: object): value is MatterWorld {
  const world = value as MatterWorld
  return Array.isArray(world.bodies) && Array.isArray(world.constraints) && typeof world.gravity?.x === 'number' && typeof world.gravity?.y === 'number' && !('z' in world.gravity)
}

function isMatterEngine(value: object): value is { world: MatterWorld } {
  const engine = value as { world?: object }
  return !!engine.world && isMatterWorld(engine.world)
}

function isCannonWorld(value: object): value is { bodies: object[]; gravity: { x: number; y: number; z: number } } {
  const world = value as { bodies?: unknown; gravity?: { z?: unknown }; addBody?: unknown }
  return Array.isArray(world.bodies) && typeof world.gravity?.z === 'number' && (typeof world.addBody === 'function' || world.bodies.length > 0)
}

function isRapierWorld(value: object): value is { gravity: Vec2; forEachRigidBody: (fn: (body: object) => void) => void } {
  const world = value as { forEachRigidBody?: unknown; gravity?: Vec2 }
  return typeof world.forEachRigidBody === 'function' && typeof world.gravity?.x === 'number' && typeof world.gravity?.y === 'number'
}

function matterBodies(world: MatterWorld): MatterBody[] {
  const all = matterNs?.Composite?.allBodies
  if (typeof all === 'function') {
    try {
      const bodies = all(world)
      if (Array.isArray(bodies)) return bodies
    } catch {
      // Composite walked something that isn't a Matter world.
    }
  }
  return world.bodies
}

function roots(bodies: MatterBody[]): MatterBody[] {
  return bodies.filter((body) => !body.parent || body.parent === body)
}

function linkedElement(body: MatterBody): Element | null {
  const plugin = body.plugin
  const candidates = [body.element, plugin?.element, plugin?.el, plugin?.dom]
  for (const candidate of candidates) if (candidate instanceof Element) return candidate
  return null
}

function centers(el: Element, root: Element): Vec2[] {
  const box = el.getBoundingClientRect()
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  const points = [{ x, y }]
  const rootBox = root.getBoundingClientRect()
  points.push({ x: x - rootBox.left, y: y - rootBox.top })
  const parent = (el as HTMLElement).offsetParent
  if (parent instanceof Element) {
    const parentBox = parent.getBoundingClientRect()
    points.push({ x: x - parentBox.left, y: y - parentBox.top })
  }
  return points
}

function matchElement(root: Element, x: number, y: number, used: Set<Element>): Element | undefined {
  const rootBox = root.getBoundingClientRect()
  let best: { el: Element; distance: number } | undefined
  const nodes = [root, ...Array.from(root.querySelectorAll('*')).slice(0, 1500)]
  for (const el of nodes) {
    if (el === root || used.has(el)) continue
    const box = el.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) continue
    if (box.width > rootBox.width * 0.9 && box.height > rootBox.height * 0.9) continue
    const distance = Math.min(...centers(el, root).map((point) => Math.hypot(point.x - x, point.y - y)))
    if (distance > MATCH_PX) continue
    if (!best || distance < best.distance) best = { el, distance }
  }
  if (!best) return undefined
  used.add(best.el)
  return best.el
}

function shapeOf(body: MatterBody): string {
  if (typeof body.circleRadius === 'number') return `circle r=${round(body.circleRadius)}`
  const bounds = body.bounds
  if (!bounds) return 'polygon'
  return `${round(bounds.max.x - bounds.min.x)}×${round(bounds.max.y - bounds.min.y)}`
}

function matterLine(body: MatterBody, target?: string): string {
  const custom = body.label && !/^(Body|Rectangle Body|Circle Body|Polygon Body)$/.test(body.label) ? ` "${body.label}"` : ''
  const where = `at (${round(body.position.x)}, ${round(body.position.y)})`
  const motion = body.isStatic
    ? 'static'
    : `dynamic, mass ${round(body.mass ?? 0)}, friction ${round(body.friction ?? 0)}, restitution ${round(body.restitution ?? 0)}, velocity (${round(body.velocity?.x ?? 0)}, ${round(body.velocity?.y ?? 0)}), angle ${round(body.angle)}`
  const link = target ? ` → \`${target}\`` : ''
  return `#${body.id}${custom} ${shapeOf(body)} ${where}, ${motion}${link}`
}

function matterTouches(world: MatterWorld, root: Element): boolean {
  const used = new Set<Element>()
  return roots(matterBodies(world)).some((body) => {
    const linked = linkedElement(body)
    if (linked && (linked === root || root.contains(linked))) return true
    return !!matchElement(root, body.position.x, body.position.y, used)
  })
}

function describeMatter(world: MatterWorld, root: Element): PhysicsWorld {
  const used = new Set<Element>()
  const bodies = roots(matterBodies(world))
  const lines = bodies.slice(0, MAX_BODIES).map((body) => {
    const linked = linkedElement(body)
    const el = linked && (linked === root || root.contains(linked)) ? linked : matchElement(root, body.position.x, body.position.y, used)
    return matterLine(body, el ? label(el) : undefined)
  })
  const extra = bodies.length - lines.length
  const gravity = world.gravity
  const scale = typeof gravity?.scale === 'number' ? `, scale: ${round(gravity.scale)}` : ''
  const constraints: string[] = []
  let mouse: string | undefined
  for (const constraint of world.constraints ?? []) {
    if (constraint.label === 'Mouse Constraint') {
      mouse = `the pointer drags bodies (stiffness ${round(constraint.stiffness ?? 0.2)})`
      continue
    }
    if (constraints.length >= MAX_CONSTRAINTS) continue
    const a = constraint.bodyA ? `#${constraint.bodyA.id}` : 'a fixed point'
    const b = constraint.bodyB ? `#${constraint.bodyB.id}` : 'a fixed point'
    constraints.push(`${a} — ${b}, length ${round(constraint.length ?? 0)}, stiffness ${round(constraint.stiffness ?? 1)}`)
  }
  return {
    engine: 'matter',
    gravity: gravity ? `{ x: ${round(gravity.x)}, y: ${round(gravity.y)}${scale} }` : 'unknown',
    bodies: [...lines.slice(0, MAX_BODIES), ...(extra ? [`… ${extra} more bodies`] : [])],
    constraints,
    mouse,
  }
}

function vec3(value: { x?: number; y?: number; z?: number } | undefined): string {
  if (!value) return '(?)'
  return typeof value.z === 'number' ? `(${round(value.x ?? 0)}, ${round(value.y ?? 0)}, ${round(value.z)})` : `(${round(value.x ?? 0)}, ${round(value.y ?? 0)})`
}

function describeCannon(world: { bodies: object[]; gravity: { x: number; y: number; z: number } }): PhysicsWorld {
  const lines = world.bodies.slice(0, MAX_BODIES).map((body, index) => {
    const item = body as {
      id?: number
      mass?: number
      type?: number
      position?: { x: number; y: number; z: number }
      velocity?: { x: number; y: number; z: number }
      shapes?: { radius?: number; halfExtents?: { x: number; y: number; z: number }; type?: unknown }[]
    }
    const shape = item.shapes?.[0]
    const kind = shape?.halfExtents
      ? `box ${round(shape.halfExtents.x * 2)}×${round(shape.halfExtents.y * 2)}×${round(shape.halfExtents.z * 2)}`
      : typeof shape?.radius === 'number'
        ? `sphere r=${round(shape.radius)}`
        : 'body'
    const fixed = item.type === 2 || item.mass === 0
    const motion = fixed ? 'static' : `dynamic, mass ${round(item.mass ?? 0)}, velocity ${vec3(item.velocity)}`
    return `#${item.id ?? index + 1} ${kind} at ${vec3(item.position)}, ${motion}`
  })
  const extra = world.bodies.length - lines.length
  return {
    engine: 'cannon',
    gravity: vec3(world.gravity),
    bodies: [...lines.slice(0, MAX_BODIES), ...(extra ? [`… ${extra} more bodies`] : [])],
    constraints: [],
  }
}

function describeRapier(world: { gravity: Vec2 & { z?: number }; forEachRigidBody: (fn: (body: object) => void) => void }): PhysicsWorld {
  const lines: string[] = []
  let more = false
  try {
    world.forEachRigidBody((body) => {
      if (lines.length >= MAX_BODIES) {
        more = true
        return
      }
      const item = body as {
        translation?: () => { x: number; y: number; z?: number }
        linvel?: () => { x: number; y: number; z?: number }
        mass?: () => number
        isFixed?: () => boolean
      }
      const at = item.translation?.()
      const fixed = item.isFixed?.() === true
      const motion = fixed ? 'static' : `dynamic, mass ${round(item.mass?.() ?? 0)}, velocity ${vec3(item.linvel?.())}`
      lines.push(`at ${vec3(at)}, ${motion}`)
    })
  } catch {
    // A Rapier build whose body methods differ. Gravity is still worth keeping.
  }
  return {
    engine: 'rapier',
    gravity: vec3(world.gravity),
    bodies: more ? [...lines, '… more bodies'] : lines,
    constraints: [],
  }
}

function sectionHasCanvas(root: Element): boolean {
  return root instanceof HTMLCanvasElement || !!root.querySelector('canvas')
}

function consider(value: unknown, root: Element, scoped: boolean, seen: Set<object>, out: PhysicsWorld[]) {
  if (!isObject(value) || out.length >= MAX_WORLDS) return
  if (isMatterEngine(value)) return consider(value.world, root, scoped, seen, out)
  if (isMatterWorld(value)) {
    if (seen.has(value)) return
    if (!scoped && !matterTouches(value, root) && !sectionHasCanvas(root)) return
    seen.add(value)
    out.push(describeMatter(value, root))
    return
  }
  if (isCannonWorld(value)) {
    if (seen.has(value)) return
    if (!scoped && !sectionHasCanvas(root)) return
    seen.add(value)
    out.push(describeCannon(value))
    return
  }
  if (isRapierWorld(value)) {
    if (seen.has(value)) return
    if (!scoped && !sectionHasCanvas(root)) return
    seen.add(value)
    out.push(describeRapier(value))
  }
}

function fiberOf(el: Element): Fiber | null {
  const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'))
  return key ? (el as unknown as Record<string, Fiber>)[key] : null
}

function scanValue(value: unknown, depth: number, seen: WeakSet<object>, visit: (value: object) => void) {
  if (!isObject(value) || seen.has(value) || depth > 2) return
  seen.add(value)
  visit(value)
  const record = value as Record<string, unknown>
  if ('current' in record) scanValue(record.current, depth + 1, seen, visit)
  if ('world' in record) scanValue(record.world, depth + 1, seen, visit)
  if ('engine' in record) scanValue(record.engine, depth + 1, seen, visit)
}

function scanFiber(fiber: Fiber, visit: (value: object) => void) {
  const seen = new WeakSet<object>()
  scanValue(fiber.memoizedProps, 0, seen, visit)
  scanValue(fiber.stateNode, 0, seen, visit)
  let hook = fiber.memoizedState
  for (let i = 0; hook && i < 40; i++, hook = hook.next) scanValue(hook.memoizedState, 0, seen, visit)
}

// Ancestors hold the component's useRef(engine). Descendants hold a child that owns the world.
// Siblings of those ancestors belong to other sections and are left alone.
function fibersAround(el: Element): Fiber[] {
  const first = fiberOf(el)
  if (!first) return []
  const seen = new Set<Fiber>()
  const out: Fiber[] = []
  let fiber: Fiber | null = first
  for (let i = 0; fiber && i < 40; i++, fiber = fiber.return ?? null) {
    if (seen.has(fiber)) break
    seen.add(fiber)
    out.push(fiber)
  }
  const stack: Fiber[] = first.child ? [first.child] : []
  while (stack.length && out.length < 800) {
    const next = stack.pop()
    if (!next || seen.has(next)) continue
    seen.add(next)
    out.push(next)
    if (next.child) stack.push(next.child)
    if (next.sibling) stack.push(next.sibling)
  }
  return out
}

export function describePhysics(root: Element): PhysicsWorld[] {
  const out: PhysicsWorld[] = []
  const seen = new Set<object>()
  for (const value of found) consider(value, root, false, seen, out)
  const visit = (value: object) => consider(value, root, true, seen, out)
  for (const fiber of fibersAround(root)) {
    if (out.length >= MAX_WORLDS) break
    scanFiber(fiber, visit)
  }
  return out
}
