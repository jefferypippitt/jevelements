// chrome.runtime.sendMessage resolves to undefined when the service worker never answers
// (it was asleep, or the message was too big to deliver). `'error' in undefined` throws, which
// used to abort a capture that had already finished gathering.

const NO_REPLY = 'Extension did not respond'

export async function askExtension<T extends object>(message: unknown): Promise<T | { error: string }> {
  try {
    const first = await chrome.runtime.sendMessage(message)
    if (isObject(first)) return first as T | { error: string }
    // Waking a stopped service worker often drops the first reply. Ask once more.
    const second = await chrome.runtime.sendMessage(message)
    if (isObject(second)) return second as T | { error: string }
    return { error: NO_REPLY }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object'
}
