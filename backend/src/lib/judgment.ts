// Confidence gates and candidate finding for the capture classifier.
// Choice confidence is TypeSafe's formula: how far the top probability sits above an even split.
// Noul answers have no separate confidence; the probability of yes is the uncertainty.
import type { CapturedNode } from './capture'

// Naming the app from a shaky label is worse than using the element's own id or class.
export const NAME_CONFIDENCE = 0.6
// A choice has to clear this before the prompt treats it as an instruction.
export const CHOICE_ACT = 0.6
// Noul bands. Near 0.5 is "unsure", not a weak yes.
export const FEATURE_ACT = 0.75
export const FEATURE_REVIEW = 0.4

export type FeatureBand = 'act' | 'review' | 'omit'

export function choiceConfidence(probabilities: Record<string, number> | undefined, optionCount: number): number | null {
  if (!probabilities || optionCount < 2) return null
  const values = Object.values(probabilities).filter((value) => Number.isFinite(value))
  if (!values.length) return null
  const top = Math.max(...values)
  const even = 1 / optionCount
  const confidence = (top - even) / (1 - even)
  return Math.min(1, Math.max(0, confidence))
}

export function featureBand(probability: number): FeatureBand {
  if (probability >= FEATURE_ACT) return 'act'
  if (probability >= FEATURE_REVIEW) return 'review'
  return 'omit'
}

// Same shape as frontend/jevelements/src/shared/kit.ts: hero → HeroSection, logo-cloud → LogoCloudSection.
export function pascalComponent(sectionType: string): string {
  const kit = sectionType.endsWith('section') ? sectionType : `${sectionType}-section`
  const component = kit
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return /^\d/.test(component) ? `Section${component}` : component
}

export interface SiblingGroup {
  id: string
  parent: string
  count: number
  child: string
  sample: string
}

const MAX_GROUPS = 8

function label(node: CapturedNode): string {
  let head = node.tag
  if (node.id) head += `#${node.id}`
  if (node.classes?.length) head += '.' + node.classes.slice(0, 3).join('.')
  return head
}

function signature(node: CapturedNode): string {
  const classes = [...(node.classes ?? [])].sort().slice(0, 4).join('.')
  return `${node.tag}|${classes}`
}

// Sibling runs code can see: three or more children with the same tag, classes, and roughly the same width.
// The model picks which run is the content template. It cannot choose a group that is not listed.
export function findSiblingGroups(root: CapturedNode): SiblingGroup[] {
  const groups: SiblingGroup[] = []

  const visit = (node: CapturedNode) => {
    if (groups.length >= MAX_GROUPS) return
    const buckets = new Map<string, CapturedNode[]>()
    for (const child of node.children) {
      const list = buckets.get(signature(child)) ?? []
      list.push(child)
      buckets.set(signature(child), list)
    }
    for (const list of buckets.values()) {
      if (groups.length >= MAX_GROUPS || list.length < 3 || !similarWidths(list)) continue
      const first = list[0]
      if (!first) continue
      const sample = list.map((child) => child.text?.trim()).find((text) => text) ?? ''
      groups.push({
        id: `g${groups.length + 1}`,
        parent: label(node),
        count: list.length,
        child: label(first),
        sample: sample.slice(0, 80),
      })
    }
    for (const child of node.children) visit(child)
  }

  visit(root)
  return groups
}

function similarWidths(nodes: CapturedNode[]): boolean {
  const widths = nodes.map((node) => node.box.w).filter((width) => width > 0)
  if (widths.length < 3) return true
  const sorted = [...widths].sort((a, b) => a - b)
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0
  if (mid <= 0) return true
  return widths.filter((width) => Math.abs(width - mid) / mid <= 0.25).length >= 3
}

export function describeGroup(group: SiblingGroup): string {
  const sample = group.sample ? ` Sample text: "${group.sample}".` : ''
  return `${group.count} similar \`${group.child}\` elements under \`${group.parent}\`.${sample}`
}
