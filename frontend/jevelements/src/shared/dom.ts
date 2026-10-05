// Element naming shared by the content script and the page probe, so both refer to the same element
// the same way the prompt's tree does: tag#id.class

function isStableClass(cls: string): boolean {
  if (cls.length > 40) return false
  if (/^(css|sc|jsx|svelte|emotion)-/.test(cls)) return false
  if (/__[A-Za-z0-9-]{4,}$/.test(cls)) return false // CSS modules: Hero_title__a1B2c
  return true
}

export function stableClasses(el: Element): string[] {
  return Array.from(el.classList).filter(isStableClass)
}

export function label(el: Element): string {
  let s = el.tagName.toLowerCase()
  if (el.id) s += `#${el.id}`
  const cls = stableClasses(el).slice(0, 2)
  if (cls.length) s += '.' + cls.join('.')
  return s
}
