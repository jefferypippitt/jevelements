// Tailwind-style variant classes and the rules the site's CSS compiled them into. Two questions:
// how the site switches its `dark:` styles on (a class or attribute on an ancestor, or the OS colour
// scheme), and which of an element's conditional classes (dark:, group-hover:, peer-*, aria-*,
// data-[…]:, supports-*) were not applying when it was captured. Tailwind v4's `dark:` follows the OS
// by default, so a rebuild of a site that switches it with a class turns dark on a computer in dark
// mode unless the spec says how the site does it.
import type { DarkVariant, ResponsiveRule, ThemeInfo } from '../shared/types'
import { normalizeColors, splitSelectors, tidyNumbers } from './extract'

export interface VariantRule {
  classes: string[] // the conditional class names the selector targets, unescaped: "dark:invert"
  selector: string // nesting resolved: `.dark\:invert:is(.dark *)`
  conditions: string[] // enclosing at-rules: "@media (prefers-color-scheme: dark)", "@supports (…)"
  declarations: string
}

const MAX_RULES = 20_000
const MAX_NOTES_PER_NODE = 8
const CONDITIONAL = /^(dark|group-.+|peer-.+|aria-.+|data-.+|supports-.+)$/
// A class in a selector, escapes included: `.dark\:bg-\[\#111\]`, `.\31 0`.
const CLASS_TOKEN = /\.((?:\\[0-9a-fA-F]{1,6} ?|\\[^\n]|[\w-]|[\u0080-\uFFFF])+)/g
const ATTR = /\[\s*([\w-]+)\s*(?:[~|^$*]?=\s*["']?([^"'\]]*?)["']?(?:\s+[is])?\s*)?\]/g
const PSEUDO_ELEMENT = /::?(before|after|placeholder|marker|selection|first-line|first-letter|backdrop|file-selector-button|-webkit-[\w-]+)\b/g
const THEME_ATTRS = ['class', 'data-theme', 'data-mode', 'data-color-mode', 'data-color-scheme', 'data-bs-theme', 'style']
const STORED_KEYS = ['theme', 'color-theme', 'color-scheme', 'colorScheme', 'vite-ui-theme', 'nuxt-color-mode', 'darkMode']

function unescapeCss(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (_, hex: string | undefined, ch: string | undefined) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : (ch ?? '')))
}

// "md:dark:hover:bg-x" → ["md", "dark", "hover"]; colons inside brackets belong to arbitrary values.
function variantsOf(cls: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of cls) {
    if (ch === '[' || ch === '(') depth++
    else if (ch === ']' || ch === ')') depth--
    if (ch === ':' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  return parts
}

export function isConditional(cls: string): boolean {
  return variantsOf(cls).some((v) => CONDITIONAL.test(v))
}

const isDark = (cls: string) => variantsOf(cls).includes('dark')

function classesIn(selector: string): string[] {
  return Array.from(selector.matchAll(CLASS_TOKEN), (m) => unescapeCss(m[1]))
}

// A nested rule's selector written out against its parent (`&:is(.dark *)` under `.dark\:invert`).
function resolveNesting(selector: string, parent: string): string {
  const scope = splitSelectors(parent).length > 1 ? `:is(${parent})` : parent
  return splitSelectors(selector)
    .map((part) => (part.includes('&') ? part.replace(/&/g, scope) : `${scope} ${part}`))
    .join(', ')
}

function addRule(selector: string, declarations: string, conditions: string[], out: VariantRule[]) {
  if (!declarations || !selector.includes('\\:') || out.length >= MAX_RULES) return
  const classes = Array.from(new Set(classesIn(selector).filter(isConditional)))
  if (classes.length) out.push({ classes, selector, conditions, declarations: normalizeColors(declarations) })
}

// Every rule whose selector targets a variant class, from compiled Tailwind v3 and v4 alike: flat
// (`@media (prefers-color-scheme: dark) { .dark\:invert {…} }`, `.dark\:invert:is(.dark *) {…}`) or
// nested (`.dark\:invert { &:is(.dark *) {…} }`, `.dark\:invert { @media (…) {…} }`).
export function collectVariantRules(rules: CSSRuleList, out: VariantRule[], conditions: string[] = [], parent: string | null = null) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const selector = parent ? resolveNesting(rule.selectorText, parent) : rule.selectorText
      addRule(selector, rule.style.cssText, conditions, out)
      if (rule.cssRules?.length) collectVariantRules(rule.cssRules, out, conditions, selector)
    } else if (rule instanceof CSSMediaRule) {
      collectVariantRules(rule.cssRules, out, [...conditions, `@media ${rule.conditionText}`], parent)
    } else if (rule instanceof CSSSupportsRule) {
      collectVariantRules(rule.cssRules, out, [...conditions, `@supports ${rule.conditionText}`], parent)
    } else if (rule instanceof CSSImportRule) {
      try {
        if (rule.styleSheet) collectVariantRules(rule.styleSheet.cssRules, out, conditions, parent)
      } catch {
        // cross-origin import without CORS
      }
    } else if (parent && 'style' in rule) {
      // Bare declarations inside a nested at-rule (CSSNestedDeclarations): they belong to the parent selector.
      addRule(parent, (rule as CSSRule & { style: CSSStyleDeclaration }).style.cssText, conditions, out)
    } else if ('cssRules' in rule) {
      const container = typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule
      const next = container ? [...conditions, `@container ${(rule as CSSContainerRule).conditionText}`] : conditions
      collectVariantRules((rule as CSSGroupingRule).cssRules, out, next, parent)
    }
  }
}

// Conditional classes used in the section.
export function sectionClasses(root: Element): Set<string> {
  const present = new Set<string>()
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const cls of Array.from(el.classList)) if (isConditional(cls)) present.add(cls)
  }
  return present
}

// The rules for each conditional class used in the section.
export function indexVariants(rules: VariantRule[], present: Set<string>): Map<string, VariantRule[]> {
  const index = new Map<string, VariantRule[]>()
  for (const rule of rules) {
    for (const cls of rule.classes) {
      if (!present.has(cls)) continue
      const list = index.get(cls) ?? []
      list.push(rule)
      index.set(cls, list)
    }
  }
  return index
}

// ---------- dark mode ----------

interface Trigger {
  kind: DarkVariant['kind']
  trigger: string // as shown: ".dark", "[data-theme=dark]", "@media (prefers-color-scheme: dark)"
  match: string // the selector that tests it, for class and attribute triggers
}

// What switches a `dark:` rule on: what is left of its selector once the variant classes are taken out
// (`:is(.dark *)`, `:where([data-theme=dark], [data-theme=dark] *)`), or the media query around it.
function darkTrigger(rule: VariantRule): Trigger | null {
  if (!rule.classes.some(isDark)) return null
  const rest = rule.selector.replace(CLASS_TOKEN, (token: string, raw: string) => (isConditional(unescapeCss(raw)) ? '' : token))
  const cls = classesIn(rest).find((c) => /dark/i.test(c))
  if (cls) return { kind: 'class', trigger: `.${cls}`, match: `.${CSS.escape(cls)}` }
  const attr = Array.from(rest.matchAll(ATTR)).find((m) => /dark/i.test(m[0]))
  if (attr) {
    const [, name, value] = attr
    if (name === 'class' && value) return { kind: 'class', trigger: `.${value}`, match: `.${CSS.escape(value)}` }
    return value
      ? { kind: 'attribute', trigger: `[${name}=${value}]`, match: `[${name}="${value.replace(/"/g, '\\"')}"]` }
      : { kind: 'attribute', trigger: `[${name}]`, match: `[${name}]` }
  }
  if (rule.conditions.some((c) => /prefers-color-scheme\s*:\s*dark/.test(c))) {
    return { kind: 'media', trigger: '@media (prefers-color-scheme: dark)', match: '' }
  }
  return null
}

function triggerActive(t: Trigger, root: Element): boolean {
  if (t.kind === 'media') return matchMedia('(prefers-color-scheme: dark)').matches
  try {
    return !!root.closest(t.match)
  } catch {
    return false
  }
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function ruleText(rule: VariantRule): string {
  const body = `${rule.selector} { ${clip(rule.declarations, 160)} }`
  return rule.conditions.reduceRight((inner, cond) => `${cond} { ${inner} }`, body)
}

function attrsOf(el: Element | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of THEME_ATTRS) {
    const value = el?.getAttribute(name)
    if (value !== null && value !== undefined) out[name] = clip(value, 300)
  }
  return out
}

function storedTheme(): string | undefined {
  try {
    for (const key of STORED_KEYS) {
      const value = localStorage.getItem(key)
      if (value && value.length < 40) return `${key}=${value}`
    }
  } catch {
    // storage blocked
  }
  return undefined
}

export function readTheme(root: Element, rules: VariantRule[], present: Set<string>): ThemeInfo {
  const groups = new Map<string, DarkVariant & { local: boolean }>()
  for (const rule of rules) {
    const t = darkTrigger(rule)
    if (!t) continue
    const key = `${t.kind} ${t.trigger}`
    // The example is a rule for a class the section uses, when there is one.
    const local = rule.classes.some((c) => present.has(c))
    const group = groups.get(key)
    if (group) {
      group.rules++
      if (local && !group.local) Object.assign(group, { example: ruleText(rule), local })
    } else {
      groups.set(key, { kind: t.kind, trigger: t.trigger, example: ruleText(rule), rules: 1, active: triggerActive(t, root), local })
    }
  }
  const methods = Array.from(groups.values(), ({ local, ...m }) => (void local, m)).sort((a, b) => b.rules - a.rules)
  const scheme = (el: Element | null) => (el ? getComputedStyle(el).colorScheme : '')
  return {
    html: attrsOf(document.documentElement),
    body: attrsOf(document.body),
    colorScheme: { html: scheme(document.documentElement), body: scheme(document.body), section: scheme(root) },
    osDark: matchMedia('(prefers-color-scheme: dark)').matches,
    stored: storedTheme(),
    methods,
    darkClasses: [root, ...Array.from(root.querySelectorAll('*'))].filter((el) => Array.from(el.classList).some(isDark)).length,
  }
}

// The section's `dark:` rules for the responsive section, which lists media queries: media-based ones
// the stylesheet walk missed (nested inside a style rule), and every selector-based one.
export function themeRules(rules: VariantRule[], present: Set<string>, existing: ResponsiveRule[], max: number): ResponsiveRule[] {
  const seen = new Set(existing.map((r) => `${r.selector}|${r.declarations}`))
  const out: ResponsiveRule[] = []
  for (const rule of rules) {
    if (out.length >= max) break
    const t = darkTrigger(rule)
    if (!t || !rule.classes.some((c) => present.has(c))) continue
    const key = `${rule.selector}|${rule.declarations}`
    if (seen.has(key)) continue
    seen.add(key)
    if (t.kind === 'media') out.push({ media: rule.conditions.join(' and '), selector: rule.selector, declarations: rule.declarations })
    else {
      const extra = rule.conditions.length ? `, inside ${rule.conditions.join(' and ')}` : ''
      out.push({ kind: 'selector', media: `dark mode: needs ${t.trigger} ${t.kind === 'class' ? 'ancestor' : 'on an ancestor'}${extra}`, selector: rule.selector, declarations: rule.declarations })
    }
  }
  return out
}

// ---------- inactive conditional classes ----------

function applies(el: Element, rule: VariantRule): boolean {
  for (const cond of rule.conditions) {
    try {
      if (cond.startsWith('@media ') && !matchMedia(cond.slice(7)).matches) return false
      if (cond.startsWith('@supports ') && !CSS.supports(cond.slice(10))) return false
    } catch {
      // unparseable condition: don't count it against the rule
    }
    // @container can't be tested from here: treated as met
  }
  try {
    return el.matches(rule.selector.replace(PSEUDO_ELEMENT, ''))
  } catch {
    return true // a selector this browser can't test: never claim it was off
  }
}

function needs(cls: string, rule: VariantRule): string {
  const variant = variantsOf(cls).find((v) => CONDITIONAL.test(v)) ?? ''
  const state = (prefix: string) => variant.slice(prefix.length).replace(/\/[\w-]+$/, '').replace(/^\[(.*)\]$/, '$1')
  const attribute = (name: string) => {
    const [key, value] = name.split('=')
    return value === undefined ? `[${key}]` : `[${key}="${value.replace(/^["']|["']$/g, '')}"]`
  }
  if (variant === 'dark') {
    const t = darkTrigger(rule)
    if (t?.kind === 'class') return `needs ${t.trigger} ancestor`
    if (t?.kind === 'attribute') return `needs ${t.trigger} on an ancestor`
    if (t?.kind === 'media') return 'needs the OS in dark mode: @media (prefers-color-scheme: dark)'
  }
  if (variant.startsWith('group-')) return `needs a .group ancestor in the ${state('group-')} state`
  if (variant.startsWith('peer-')) return `needs an earlier .peer sibling in the ${state('peer-')} state`
  if (variant.startsWith('aria-')) {
    const s = state('aria-')
    return `needs ${s.includes('=') ? attribute(`aria-${s}`) : `[aria-${s}="true"]`}`
  }
  if (variant.startsWith('data-')) return `needs ${attribute(`data-${state('data-')}`)}`
  if (variant.startsWith('supports-')) return `needs @supports (${state('supports-')})`
  const cond = rule.conditions.join(' and ')
  return cond ? `needs ${cond}` : `needs ${rule.selector}`
}

// One line per conditional class whose rules weren't applying to the element when it was captured:
// "`dark:invert` — inactive at capture (needs .dark ancestor); the computed `filter` is `none`".
export function conditionalNotes(el: Element, index: Map<string, VariantRule[]>): string[] {
  const out: string[] = []
  for (const cls of Array.from(el.classList)) {
    if (out.length >= MAX_NOTES_PER_NODE) break
    const rules = index.get(cls)
    if (!rules?.length || rules.some((r) => applies(el, r))) continue
    const rule = rules[0]
    const pseudo = /::?(before|after)\b/.exec(rule.selector)?.[1]
    const cs = getComputedStyle(el, pseudo ? `::${pseudo}` : null)
    const props = Array.from(new Set(rules.flatMap((r) => r.declarations.split(';').map((d) => d.split(':')[0].trim())))).filter(Boolean)
    const real = props.filter((p) => !p.startsWith('--')).slice(0, 3)
    const shown = real.length
      ? real.map((p) => `the computed \`${pseudo ? `::${pseudo} ` : ''}${p}\` is \`${clip(tidyNumbers(normalizeColors(cs.getPropertyValue(p))), 80) || '(unset)'}\``).join(', ')
      : `it only sets ${props.slice(0, 3).join(', ')}`
    out.push(`\`${cls}\` — inactive at capture (${needs(cls, rule)}); ${shown}`)
  }
  return out
}
