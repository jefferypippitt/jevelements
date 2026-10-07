// Names the rebuild: the app folder and the component, from jev's classification (hero, pricing,
// navbar) when that label is confident, or from the captured element's id, class, or tag.
import type { Capture } from './types'

const TAG_NAMES: Record<string, string> = { header: 'header', nav: 'navbar', footer: 'footer', aside: 'sidebar', form: 'form' }
const UTILITY_CLASS = /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|container|wrapper|inner|outer|row|col|w-|h-|p[xytrbl]?-|m[xytrbl]?-|gap-|bg-|text-|items-|justify-|overflow-|z-|min-|max-|mx-|my-|framer-|css-|sc-|jsx-)/

function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// A readable word from an element's id or classes (`#pricing`, `.feature-grid`), skipping utility classes.
export function readableName(names: (string | undefined)[]): string | null {
  for (const raw of names) {
    if (!raw || UTILITY_CLASS.test(raw)) continue
    const name = kebab(raw).replace(/-?section$/, '')
    if (/^[a-z][a-z-]{2,23}$/.test(name)) return name
  }
  return null
}

// A readable word from the element itself: `#pricing`, `.feature-grid`, <footer>.
function elementName(capture: Capture): string | null {
  const root = capture.root
  return readableName([root.id, ...(root.classes ?? [])]) ?? TAG_NAMES[root.tag] ?? null
}

export function kitBase(capture: Capture): string {
  const type = capture.analysis?.sectionType.value
  const base = (capture.analysis?.nameFromType && type ? kebab(type) : elementName(capture)) || ''
  return base ? (base.endsWith('section') ? base : `${base}-section`) : 'section'
}

// shadcn-style names: hero-section → components/hero-section.tsx exporting HeroSection.
export function componentNames(kit: string): { file: string; component: string } {
  const component = kit
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return { file: kit, component: /^\d/.test(component) ? `Section${component}` : component }
}

// The rebuild is always its own new Next.js app, in a folder with the same name as the component.
export function projectName(capture: Capture): string {
  return kitBase(capture)
}
