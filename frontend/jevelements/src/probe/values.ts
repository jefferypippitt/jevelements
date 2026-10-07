// Answers the canvas pointer sweep (content/sweep.ts): every number the renderer of one canvas holds
// right now, so the sweep can tell which of them follow the pointer. Synchronous, since the sweep reads
// it every frame while it watches a value ease toward the pointer.
import { PROBE_VALUES_EVENT, PROBE_VALUES_RESULT_EVENT } from '../shared/runtime'
import type { HookState } from './hooks'
import { threeValues } from './three'

function canvasValues(canvas: HTMLCanvasElement, state: HookState): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const [name, rec] of state.uniforms.get(canvas) ?? []) out[name] = rec.value.slice()
  for (const ref of state.renderers) {
    const renderer = ref.deref()
    if (renderer?.domElement === canvas) for (const [name, value] of threeValues(renderer, state)) out[name] ??= value
  }
  return out
}

export function answerValues(state: HookState) {
  document.addEventListener(
    PROBE_VALUES_EVENT,
    (e) => {
      const canvas = e.composedPath()[0]
      const values = canvas instanceof HTMLCanvasElement ? canvasValues(canvas, state) : {}
      document.dispatchEvent(new CustomEvent(PROBE_VALUES_RESULT_EVENT, { detail: JSON.stringify(values) }))
    },
    true,
  )
}
