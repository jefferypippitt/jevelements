// Turns live JavaScript values (animation vars, uniforms, options) into readable code-like text.
import { label } from '../shared/dom'

export function round(n: number, digits = 3): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

// A JS literal for a value, e.g. { y: 40, opacity: 0, ease: "power3.out", onComplete: /* function */ }.
// Elements become their label; deep or long structures are cut short.
export function literal(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(round(value, 4)) : String(value)
  if (typeof value === 'string') return JSON.stringify(value.length > 300 ? value.slice(0, 300) + '…' : value)
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return '/* function */'
  if (typeof Element !== 'undefined' && value instanceof Element) return JSON.stringify(label(value))
  if (depth > 2) return Array.isArray(value) ? '[…]' : '{…}'
  if (Array.isArray(value)) {
    const items = value.slice(0, 12).map((v) => literal(v, depth + 1))
    return `[${items.join(', ')}${value.length > 12 ? ', …' : ''}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 30)
    if (!entries.length) return '{}'
    return `{ ${entries.map(([k, v]) => `${IDENTIFIER.test(k) ? k : JSON.stringify(k)}: ${literal(v, depth + 1)}`).join(', ')} }`
  }
  return String(value)
}

export function hex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')
}

export function truncateText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n/* … ${s.length - max} more characters */` : s
}
