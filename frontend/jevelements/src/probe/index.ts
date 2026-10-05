// Page probe: runs in the page's own JavaScript world, from document_start on every page (manifest
// content_scripts, world MAIN), so its hooks are in place before the page's scripts create WebGL
// contexts or three.js renderers. Pages that loaded before the extension get it injected on demand,
// without the hook data. The content script asks it about a section with a "jev:inspect" event.
import type { RuntimeData } from '../shared/types'
import { PROBE_ACK_EVENT, PROBE_INSPECT_EVENT, PROBE_RESULT_EVENT } from '../shared/runtime'
import { installHooks, type HookState } from './hooks'
import { inspectRuntime } from './inspect'
import { hookListeners } from './listeners'

const KEY = '__jevProbe'

if (!(KEY in window)) {
  // The default 250-entry resource log fills up on big pages before a lazy video starts, and the
  // capture needs its stream manifest (.m3u8/.mpd) from that log.
  performance.setResourceTimingBufferSize(3000)
  const state: HookState = installHooks(document.readyState !== 'loading')
  hookListeners()
  Object.defineProperty(window, KEY, { value: true })

  document.addEventListener(PROBE_INSPECT_EVENT, (e) => {
    const id = (e as CustomEvent<unknown>).detail
    if (typeof id !== 'string') return
    document.dispatchEvent(new CustomEvent(PROBE_ACK_EVENT, { detail: id }))
    const reply = (data: RuntimeData | null, error?: string) =>
      document.dispatchEvent(new CustomEvent(PROBE_RESULT_EVENT, { detail: JSON.stringify({ id, data, error }) }))
    inspectRuntime(state).then(
      (data) => reply(data),
      (err) => reply(null, err instanceof Error ? err.message : String(err)),
    )
  })
}
