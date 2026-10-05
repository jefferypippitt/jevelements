// CSS :hover for synthetic playback. Dispatched pointer events run the page's JavaScript handlers but
// never switch on :hover, so the stylesheet's :hover rules are copied with :hover swapped for an
// attribute, and that attribute is set on the hovered element and its ancestors (a real pointer
// hovers every ancestor too). Same specificity as :hover, so the rules apply as they would for a user.

export interface HoverRule {
  selector: string // one selector from the rule, still containing :hover
  media: string | null // wrapping @media / @container condition, when there is one
  declarations: string
}

const ATTR = 'data-jev-hover'
const HOVER = /:hover\b/g
const STATES = /:(hover|focus-visible|focus-within|focus|active)\b/g
const PSEUDO_ELEMENT = /::?(before|after|placeholder|marker|selection|first-line|first-letter|backdrop)\b|::[\w-]+(\([^)]*\))?/g

// The element a pointer must be over for the rule to apply: `.grid .card:hover .title` → `.grid .card`.
// Null when :hover sits inside :is()/:has()/:not(), which this can't split.
export function hoverTarget(selector: string): string | null {
  const at = selector.search(/:hover\b/)
  if (at < 0) return null
  let end = at + ':hover'.length
  while (end < selector.length && !/[\s>+~]/.test(selector[end])) end++
  const prefix = selector.slice(0, end)
  if (prefix.split('(').length !== prefix.split(')').length) return null
  let target = prefix.replace(PSEUDO_ELEMENT, '').replace(STATES, '').trim()
  if (!target || /[>+~]$/.test(target)) target += '*'
  return target
}

export class ForcedHover {
  private style: HTMLStyleElement | null = null
  private marked: Element[] = []
  private readonly rules: HoverRule[]

  constructor(rules: HoverRule[]) {
    this.rules = rules
  }

  on(el: Element) {
    if (!this.rules.length) return
    if (!this.style) {
      this.style = document.createElement('style')
      this.style.textContent = this.rules
        .map((r) => {
          const rule = `${r.selector.replace(HOVER, `[${ATTR}]`)} { ${r.declarations} }`
          return r.media ? `${r.media} { ${rule} }` : rule
        })
        .join('\n')
      ;(document.head ?? document.documentElement).append(this.style)
    }
    for (let p: Element | null = el; p; p = p.parentElement) {
      p.setAttribute(ATTR, '')
      this.marked.push(p)
    }
  }

  off() {
    this.marked.forEach((el) => el.removeAttribute(ATTR))
    this.marked = []
  }

  dispose() {
    this.off()
    this.style?.remove()
    this.style = null
  }
}
