// Keeps the page where it is while the content script plays a section's hovers and clicks. A button's
// click handler can leave the page in ways the content script can't stop from its isolated world:
// `location.href = …`, a router's history.pushState, window.open. The Navigation API's `navigate`
// event sees all of them (and plain link clicks and form submits) before they happen, in the page's
// own world, so it runs here.
//
// Same-document changes on the same path (#hash tabs, ?tab=2) are let through: they don't leave
// the section. Everything else is cancelled when the browser allows it, and its URL is reported on
// <html> so the content script stops clicking.
import { PROBE_BLOCKED_ATTR, PROBE_BLOCKED_TARGET_ATTR, PROBE_GUARD_ATTR, PROBE_GUARD_EVENT } from '../shared/runtime'

const SAFETY_MS = 90_000 // turns itself off if the content script never does (it crashed, the tab was reloaded)

export function installNavigationGuard() {
  const html = () => document.documentElement // read late: there may be no <html> yet at install
  let on = false
  let timer = 0

  const set = (value: boolean) => {
    on = value
    clearTimeout(timer)
    html().removeAttribute(PROBE_BLOCKED_ATTR)
    html().removeAttribute(PROBE_BLOCKED_TARGET_ATTR)
    if (value) {
      html().setAttribute(PROBE_GUARD_ATTR, '')
      timer = window.setTimeout(() => set(false), SAFETY_MS)
    } else html().removeAttribute(PROBE_GUARD_ATTR)
  }

  document.addEventListener(PROBE_GUARD_EVENT, (e) => {
    const detail = (e as CustomEvent<unknown>).detail
    if (detail === 'on' || detail === 'off') set(detail === 'on')
  })

  window.navigation?.addEventListener('navigate', (e) => {
    if (!on) return
    const to = new URL(e.destination.url)
    if (e.destination.sameDocument && to.origin === location.origin && to.pathname === location.pathname) return
    if (e.cancelable) e.preventDefault()
    html().setAttribute(PROBE_BLOCKED_ATTR, e.destination.url)
    html().setAttribute(PROBE_BLOCKED_TARGET_ATTR, '_self')
  })

  const open = window.open
  window.open = function (this: Window, ...args: Parameters<typeof window.open>) {
    if (!on) return open.apply(this, args)
    let url = 'a new window'
    try {
      if (args[0] !== undefined && args[0] !== '') url = new URL(String(args[0]), location.href).href
    } catch {
      url = String(args[0])
    }
    html().setAttribute(PROBE_BLOCKED_ATTR, url)
    html().setAttribute(PROBE_BLOCKED_TARGET_ATTR, args[1] ? String(args[1]) : '_blank')
    return null
  }
}
