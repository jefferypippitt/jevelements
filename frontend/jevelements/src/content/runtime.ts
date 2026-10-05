// Asks the page probe (src/probe) what the page's JavaScript knows about the captured section. On pages
// that loaded before the extension the probe isn't there yet: the background worker injects it and
// the question is asked again (without hook data, which the result's `lateProbe` flags).
import type { BackgroundMessage, RuntimeData } from '../shared/types'
import { PROBE_ACK_EVENT, PROBE_INSPECT_EVENT, PROBE_RESULT_EVENT, PROBE_ROOT_ATTR } from '../shared/runtime'

const ACK_TIMEOUT_MS = 500
const RESULT_TIMEOUT_MS = 20_000 // exporting a big three.js scene can take a while

function ask(): Promise<RuntimeData | 'no-probe' | null> {
  const id = crypto.randomUUID()
  return new Promise((resolve) => {
    let ackTimer = 0
    let resultTimer = 0
    const finish = (value: RuntimeData | 'no-probe' | null) => {
      clearTimeout(ackTimer)
      clearTimeout(resultTimer)
      document.removeEventListener(PROBE_ACK_EVENT, onAck)
      document.removeEventListener(PROBE_RESULT_EVENT, onResult)
      resolve(value)
    }
    const onAck = (e: Event) => {
      if ((e as CustomEvent<unknown>).detail === id) clearTimeout(ackTimer)
    }
    const onResult = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail
      if (typeof detail !== 'string') return
      try {
        const reply = JSON.parse(detail) as { id: string; data: RuntimeData | null; error?: string }
        if (reply.id !== id) return
        if (reply.error) console.warn('[jevelements] page probe failed:', reply.error)
        finish(reply.data)
      } catch {
        // not ours
      }
    }
    document.addEventListener(PROBE_ACK_EVENT, onAck)
    document.addEventListener(PROBE_RESULT_EVENT, onResult)
    ackTimer = window.setTimeout(() => finish('no-probe'), ACK_TIMEOUT_MS)
    resultTimer = window.setTimeout(() => finish(null), RESULT_TIMEOUT_MS)
    document.dispatchEvent(new CustomEvent(PROBE_INSPECT_EVENT, { detail: id }))
  })
}

export async function inspectRuntime(root: Element): Promise<RuntimeData | undefined> {
  root.setAttribute(PROBE_ROOT_ATTR, '')
  try {
    let result = await ask()
    if (result === 'no-probe') {
      const message: BackgroundMessage = { type: 'jev:inject-probe' }
      await chrome.runtime.sendMessage(message)
      result = await ask()
    }
    return result && result !== 'no-probe' ? result : undefined
  } catch (err) {
    console.warn('[jevelements] could not reach the page probe', err)
    return undefined
  } finally {
    root.removeAttribute(PROBE_ROOT_ATTR)
  }
}
