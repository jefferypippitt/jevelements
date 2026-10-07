// How the content script (isolated world) and the page probe (page world) talk: DOM events on
// `document` with string payloads, since objects don't cross between JavaScript worlds. The content
// script marks the captured element with PROBE_ROOT_ATTR while the probe inspects it.
export const PROBE_INSPECT_EVENT = 'jev:inspect'
export const PROBE_ACK_EVENT = 'jev:inspect-ack' // sent right away, so a missing probe is noticed quickly
export const PROBE_RESULT_EVENT = 'jev:inspect-result'
export const PROBE_ROOT_ATTR = 'data-jev-root'
// Set by the probe on elements with hover/click handlers ("hover", "click" or both); removed by the
// content script once it has played them.
export const PROBE_INTERACTIVE_ATTR = 'data-jev-interactive'
// Controls a click rendered later (a mock UI's next state) weren't there for the first scan. The
// content script sets PROBE_MARK_ATTR on the part to scan again and sends PROBE_MARK_EVENT; the probe
// marks its handlers synchronously.
export const PROBE_MARK_EVENT = 'jev:mark'
export const PROBE_MARK_ATTR = 'data-jev-mark'
// "window" when the page listens for the pointer's position (mousemove/pointermove) on window or document,
// "section" when the captured element, an element in it or a wrapper around it does (React's onMouseMove
// too). The hover sweep (content/sweep.ts) sweeps the section only then, and removes it after.
export const PROBE_POINTER_ATTR = 'data-jev-pointer'
// The content script turns the probe's navigation guard on ("on") while it plays a section's hovers
// and clicks, and off ("off") after. The probe sets PROBE_GUARD_ATTR on <html> while the guard is on,
// so the content script can tell it's really there, PROBE_BLOCKED_ATTR to the URL of a navigation it
// cancelled, and PROBE_BLOCKED_TARGET_ATTR to where it would have opened: "_self" (this tab) or the
// window.open target ("_blank", a named window).
export const PROBE_GUARD_EVENT = 'jev:guard'
export const PROBE_GUARD_ATTR = 'data-jev-guard'
export const PROBE_BLOCKED_ATTR = 'data-jev-blocked'
export const PROBE_BLOCKED_TARGET_ATTR = 'data-jev-blocked-target'
// While the content script explores a component's states, it asks the probe to hold the page's long
// timers ("hold", then "release"), so a demo that plays itself stays in the state a click put it in.
// The probe sets PROBE_CLOCK_ATTR on <html> while it holds them.
export const PROBE_CLOCK_EVENT = 'jev:clock'
export const PROBE_CLOCK_ATTR = 'data-jev-clock'
// The canvas pointer sweep (content/sweep.ts) asks for the numbers a canvas's renderer holds (raw WebGL
// uniforms, three.js uniforms, camera and object transforms) by dispatching PROBE_VALUES_EVENT on the
// canvas itself, which reaches the probe from inside shadow roots too. The probe answers synchronously
// with PROBE_VALUES_RESULT_EVENT, a JSON object of name → numbers.
export const PROBE_VALUES_EVENT = 'jev:values'
export const PROBE_VALUES_RESULT_EVENT = 'jev:values-result'
// While the click sweep clicks things nothing in the markup says are safe, the content script asks
// the probe to block requests that write to a server ("block", then "allow"). The probe sets
// PROBE_WRITES_ATTR on <html> while it blocks, and lists what it blocked, one per line, in
// PROBE_WRITES_BLOCKED_ATTR.
export const PROBE_WRITES_EVENT = 'jev:writes'
export const PROBE_WRITES_ATTR = 'data-jev-writes'
export const PROBE_WRITES_BLOCKED_ATTR = 'data-jev-writes-blocked'
// The light/dark comparison (content/scheme.ts) asks the probe to make the page's scripts see an OS
// colour scheme ("light" or "dark", then "off"): matchMedia answers for it and `change` listeners
// hear the switch. The probe sets PROBE_SCHEME_ATTR on <html> to the scheme while it emulates one.
export const PROBE_SCHEME_EVENT = 'jev:scheme'
export const PROBE_SCHEME_ATTR = 'data-jev-scheme'
// A media query condition on the OS colour scheme, and the same query with it decided: always true
// for the emulated scheme, never for the other, so the rest of the query is still evaluated.
export const COLOR_SCHEME_QUERY = /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi
export function emulateColorScheme(media: string, scheme: 'light' | 'dark'): string {
  return media.replace(COLOR_SCHEME_QUERY, (_, wanted: string) => (wanted.toLowerCase() === scheme ? '(width >= 0px)' : '(width < 0px)'))
}
export function mentionsColorScheme(media: string): boolean {
  COLOR_SCHEME_QUERY.lastIndex = 0
  return COLOR_SCHEME_QUERY.test(media)
}
// "page" when a click listener sits on the window or document, "section" when it sits on the section,
// a wrapper around it or a container inside it (React's onClick too, not its root listener): an
// element with only `cursor: pointer` may be handled by it, and a canvas may react where it is clicked.
// Set by the probe while it inspects the section; the click sweep removes it.
export const PROBE_CLICK_ATTR = 'data-jev-click'
