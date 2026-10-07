// Keeps the page from writing to its servers while the click sweep clicks things nothing in the markup
// says are safe (a card a delegated listener handles may also "like" a post or add to a cart). While
// it's on, requests that change data (fetch and XHR with POST, PUT, PATCH, DELETE…), beacons and
// WebSocket messages fail as if the network had dropped them, and what was blocked is listed on <html>
// for the content script. Reads (GET, HEAD) go through, so a panel that loads its content still opens.
//
// It needs the page's own world (the content script's fetch is a different one), so it runs here.
import { PROBE_WRITES_ATTR, PROBE_WRITES_BLOCKED_ATTR, PROBE_WRITES_EVENT } from '../shared/runtime'

const SAFETY_MS = 120_000 // turns itself off if the content script never does
const MAX_LISTED = 10

export function installWriteGuard() {
  const html = () => document.documentElement
  let on = false
  let timer = 0
  const set = (value: boolean) => {
    on = value
    clearTimeout(timer)
    if (value) {
      html().setAttribute(PROBE_WRITES_ATTR, '')
      html().removeAttribute(PROBE_WRITES_BLOCKED_ATTR)
      timer = window.setTimeout(() => set(false), SAFETY_MS)
    } else html().removeAttribute(PROBE_WRITES_ATTR)
  }
  document.addEventListener(PROBE_WRITES_EVENT, (e) => {
    const detail = (e as CustomEvent<unknown>).detail
    if (detail === 'block' || detail === 'allow') set(detail === 'block')
  })

  const writes = (method: string | undefined) => on && !/^(GET|HEAD|OPTIONS)$/i.test(method ?? 'GET')
  const note = (what: string) => {
    const list = (html().getAttribute(PROBE_WRITES_BLOCKED_ATTR) ?? '').split('\n').filter(Boolean)
    if (list.length < MAX_LISTED) html().setAttribute(PROBE_WRITES_BLOCKED_ATTR, [...list, what.slice(0, 160)].join('\n'))
  }
  const where = (url: unknown) => {
    try {
      const u = new URL(String(url), location.href)
      return u.origin === location.origin ? u.pathname : u.origin + u.pathname
    } catch {
      return String(url)
    }
  }

  const fetch0 = window.fetch
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (writes(method)) {
      note(`${method.toUpperCase()} ${where(input instanceof Request ? input.url : input)}`)
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    return fetch0.call(this, input, init)
  } as typeof window.fetch

  const requests = new WeakMap<XMLHttpRequest, { method: string; url: string }>()
  const open0 = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    requests.set(this, { method, url: String(url) })
    return (open0 as (...args: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof XMLHttpRequest.prototype.open
  const send0 = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const req = requests.get(this)
    if (req && writes(req.method)) {
      note(`${req.method.toUpperCase()} ${where(req.url)}`)
      // Fails the way a dropped connection does: an error, then loadend.
      setTimeout(() => {
        this.dispatchEvent(new ProgressEvent('error'))
        this.dispatchEvent(new ProgressEvent('loadend'))
      })
      return
    }
    return send0.call(this, body)
  }

  const beacon0 = navigator.sendBeacon?.bind(navigator)
  if (beacon0) {
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      if (on) {
        note(`beacon ${where(url)}`)
        return false
      }
      return beacon0(url, data)
    }
  }

  const wsSend0 = window.WebSocket?.prototype.send
  if (wsSend0) {
    WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
      if (on) {
        note(`WebSocket message to ${where(this.url)}`)
        return
      }
      return wsSend0.call(this, data)
    }
  }
}
