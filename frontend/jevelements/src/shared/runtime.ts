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
// "window" when the page listens for mousemove on window/document, "section" when the captured
// element itself does. The content script sweeps the pointer across and then removes it.
export const PROBE_POINTER_ATTR = 'data-jev-pointer'
// The content script turns the probe's navigation guard on ("on") while it plays a section's hovers
// and clicks, and off ("off") after. The probe sets PROBE_GUARD_ATTR on <html> while the guard is on,
// so the content script can tell it's really there, and PROBE_BLOCKED_ATTR to the URL of a
// navigation it cancelled.
export const PROBE_GUARD_EVENT = 'jev:guard'
export const PROBE_GUARD_ATTR = 'data-jev-guard'
export const PROBE_BLOCKED_ATTR = 'data-jev-blocked'
// While the content script explores a component's states, it asks the probe to hold the page's long
// timers ("hold", then "release"), so a demo that plays itself stays in the state a click put it in.
// The probe sets PROBE_CLOCK_ATTR on <html> while it holds them.
export const PROBE_CLOCK_EVENT = 'jev:clock'
export const PROBE_CLOCK_ATTR = 'data-jev-clock'
