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
