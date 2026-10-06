// Holds the page's long timers while the content script explores a component's states. Product demos
// play themselves: a timer switches the agent every few seconds, so a state the explorer clicked into
// is gone before it is read, and it never finds its way back to one. While held, timeouts and
// intervals of HOLD_MS or more don't fire, including ones scheduled meanwhile (a React effect that
// re-arms the tour after a click); shorter ones (a reply streaming in, a caret) run as usual.
// Released, each held one is scheduled again with its full delay.
import { PROBE_CLOCK_ATTR, PROBE_CLOCK_EVENT } from '../shared/runtime'

const HOLD_MS = 2000
const SAFETY_MS = 300_000 // released by itself if the content script never does
const FIRST_ID = 1_000_000_000 // ids for long timers, clear of the browser's own

interface Timer {
  native: number
  fn: (...args: unknown[]) => void
  ms: number
  args: unknown[]
  repeat: boolean
  held: boolean
}

export function installClock() {
  const setTimeoutNative = window.setTimeout.bind(window)
  const setIntervalNative = window.setInterval.bind(window)
  const clearNative = window.clearTimeout.bind(window) // clears intervals too
  const timers = new Map<number, Timer>()
  let nextId = FIRST_ID
  let holding = false
  let safety = 0

  const start = (id: number, t: Timer) => {
    t.held = false
    t.native = t.repeat
      ? setIntervalNative(() => t.fn(...t.args), t.ms)
      : setTimeoutNative(() => {
          timers.delete(id)
          t.fn(...t.args)
        }, t.ms)
  }

  const schedule = (repeat: boolean) =>
    function (this: unknown, handler: TimerHandler, ms?: number, ...args: unknown[]): number {
      const delay = Number(ms) || 0
      if (delay < HOLD_MS || typeof handler !== 'function') return (repeat ? setIntervalNative : setTimeoutNative)(handler, ms, ...args)
      const id = nextId++
      const t: Timer = { native: 0, fn: handler as (...a: unknown[]) => void, ms: delay, args, repeat, held: holding }
      timers.set(id, t)
      if (!holding) start(id, t)
      return id
    }

  const clear = (id?: number) => {
    const t = id === undefined ? undefined : timers.get(id)
    if (!t) return clearNative(id)
    timers.delete(id!)
    if (!t.held) clearNative(t.native)
  }

  window.setTimeout = schedule(false) as typeof window.setTimeout
  window.setInterval = schedule(true) as typeof window.setInterval
  window.clearTimeout = clear
  window.clearInterval = clear

  const hold = (on: boolean) => {
    clearNative(safety)
    if (on) safety = setTimeoutNative(() => hold(false), SAFETY_MS)
    if (on === holding) return
    holding = on
    if (on) {
      for (const t of timers.values()) {
        if (t.held) continue
        clearNative(t.native)
        t.held = true
      }
      document.documentElement.setAttribute(PROBE_CLOCK_ATTR, '')
    } else {
      for (const [id, t] of timers) if (t.held) start(id, t)
      document.documentElement.removeAttribute(PROBE_CLOCK_ATTR)
    }
  }

  document.addEventListener(PROBE_CLOCK_EVENT, (e) => {
    const detail = (e as CustomEvent<unknown>).detail
    if (detail === 'hold' || detail === 'release') hold(detail === 'hold')
  })
}
