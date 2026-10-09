// The anatomy of a landing page, as the section-type question's options. Each type belongs to a
// family (what the section does for a visitor: introduce, prove, explain, convert, answer). Jev picks
// one type; code sums the type probabilities per family, so a section that is clearly "some kind of
// feature section" still gets a confident family when the vote splits between feature-grid,
// feature-rows and bento-grid.
//
// Criteria are objects (what / not_for / cues), as the TypeSafe docs suggest for options the model
// confuses. Option names and descriptions are both sent to the model.
import { choiceConfidence } from './judgment'

export const FAMILIES = {
  navigation: 'navigation',
  hero: 'hero',
  'social-proof': 'social proof',
  features: 'features',
  conversion: 'conversion',
  faq: 'faq',
  content: 'content',
  footer: 'footer',
  other: 'other',
} as const

export type Family = keyof typeof FAMILIES

interface SectionTypeSpec {
  family: Family
  what: string
  not_for?: string
  cues?: string
}

export const SECTION_TYPES = {
  navbar: {
    family: 'navigation',
    what: 'Top bar with the logo, page links and usually a sign-in or primary button',
    cues: '<nav> or <header>, a row of short links, sits at the very top',
  },
  'announcement-bar': {
    family: 'navigation',
    what: 'Thin strip above or below the navbar with one short message or promo link',
    cues: 'Very short height, one line of text, often a "Learn more" link',
  },
  hero: {
    family: 'hero',
    what: "The page's opening band: the main promise as a headline, a subline, primary and secondary buttons, often a product visual",
    not_for: 'A headline with a visual further down the page (that is feature-showcase), or a closing banner (that is cta)',
    cues: 'First band below the navbar, holds the page h1, near the top of the page',
  },
  'logo-cloud': {
    family: 'social-proof',
    what: 'Row or grid of customer, partner or press logos, often under a line like "Trusted by"',
    not_for: 'Logos of tools the product connects to (that is integrations)',
    cues: 'Many small images or SVGs, little text, sometimes a marquee',
  },
  testimonials: {
    family: 'social-proof',
    what: 'Customer quotes or reviews with names, roles, avatars or star ratings',
    not_for: 'A single in-depth customer story with metrics (that is case-study)',
    cues: 'Quote marks, blockquote, person names and job titles, ratings',
  },
  stats: {
    family: 'social-proof',
    what: 'A few big numbers or metrics with short labels',
    cues: 'Large short texts like "10M+", "99.9%", "4.9/5" each with a caption',
  },
  'case-study': {
    family: 'social-proof',
    what: 'One customer story: company logo, a quote or result, metrics, and a link to read more',
    not_for: 'A grid of many short quotes (that is testimonials)',
  },
  problem: {
    family: 'features',
    what: 'States the pain or the old way of doing things before the product, often a before/after contrast',
    cues: 'Words like "without", "struggle", "instead of", crossed-out or muted lists',
  },
  'feature-grid': {
    family: 'features',
    what: 'Grid of three or more equal tiles, each an icon or image, a short title and a sentence about a feature or benefit',
    not_for: 'Articles with dates or authors (that is blog-list), quotes (that is testimonials), price tiers (that is pricing)',
    cues: 'Repeated cards with h3 titles and one sentence each, icons, a section heading above',
  },
  'feature-rows': {
    family: 'features',
    what: 'Features as alternating rows: text on one side, an image or demo on the other, swapping sides row by row',
    cues: 'Two-column rows stacked vertically, each with its own heading and visual',
  },
  'bento-grid': {
    family: 'features',
    what: 'Asymmetric mosaic of feature tiles in different sizes, each with a title and a visual',
    not_for: 'Equal-size tiles (that is feature-grid)',
    cues: 'Grid items spanning different column or row counts, rich visuals in tiles',
  },
  'feature-showcase': {
    family: 'features',
    what: 'One feature or product area explained with a section headline and a large screenshot, demo, or interactive visual, sometimes with tabs or callouts',
    not_for: "The page's opening band (that is hero)",
    cues: 'An h2 headline, a big visual, a short description, below the hero on the page',
  },
  'how-it-works': {
    family: 'features',
    what: 'A numbered sequence of steps showing how the product is used',
    cues: 'Step numbers like 1, 2, 3 or "Step 1", arrows or a connecting line',
  },
  integrations: {
    family: 'features',
    what: 'Tools and platforms the product connects to, shown as app icons or logo tiles with names',
    not_for: 'Customer logos used as proof (that is logo-cloud)',
  },
  'use-cases': {
    family: 'features',
    what: 'Cards or tabs per audience, role, team, or industry showing how each uses the product',
    cues: 'Titles like "For startups", "For marketing teams", "Ecommerce"',
  },
  comparison: {
    family: 'features',
    what: 'Comparison table or side-by-side of the product versus alternatives or plans',
    cues: 'Table rows of features with check marks or crosses across columns',
  },
  pricing: {
    family: 'conversion',
    what: 'Pricing plans or tiers with prices, feature lists and a button per plan',
    cues: 'Currency amounts, "/mo", "per user", plan names, a monthly/yearly toggle',
  },
  cta: {
    family: 'conversion',
    what: 'Standalone banner asking the visitor to act: one headline and one or two buttons, usually near the end of the page',
    not_for: "The page's opening band (that is hero)",
  },
  'contact-form': {
    family: 'conversion',
    what: 'Form for contacting sales, booking a demo or signing up, with several fields',
    not_for: 'A single email field (that is newsletter)',
  },
  newsletter: {
    family: 'conversion',
    what: 'Email signup for updates: one email field and a subscribe button',
  },
  faq: {
    family: 'faq',
    what: 'Frequently asked questions, usually expandable question rows',
    cues: 'Question marks in many short headings or buttons, accordion toggles',
  },
  'blog-list': {
    family: 'content',
    what: 'List or grid of articles, posts, guides or changelog entries',
    cues: 'Dates, read times, author names, category tags, thumbnails',
  },
  team: {
    family: 'content',
    what: 'People on the team with photos, names and roles',
  },
  footer: {
    family: 'footer',
    what: 'Page footer with columns of links, social icons and legal text',
    cues: '<footer>, copyright ©, privacy and terms links, sits at the very bottom',
  },
  card: {
    family: 'other',
    what: 'A single card, button group, or small component rather than a full-width page section',
  },
  other: {
    family: 'other',
    what: 'A page section that fits none of the above',
  },
} as const satisfies Record<string, SectionTypeSpec>

export type SectionType = keyof typeof SECTION_TYPES

export function familyOf(type: string): Family {
  return type in SECTION_TYPES ? SECTION_TYPES[type as SectionType].family : 'other'
}

// The question's options: the type spec without the family (code's business, not the model's).
export const SECTION_TYPE_CRITERIA = Object.fromEntries(
  Object.entries(SECTION_TYPES).map(([type, spec]) => [type, Object.fromEntries(Object.entries(spec).filter(([key]) => key !== 'family'))]),
) as Record<SectionType, { what: string; not_for?: string; cues?: string }>

export const SECTION_TYPE_INSTRUCTIONS = {
  question: 'Which part of a landing page is `captured`?',
  how: 'Decide by the job the section does for a visitor (navigate, introduce, prove, explain, convert, answer questions, list content, close the page), then by its layout. `placement` says where it sits on the page, `content` lists its headings, buttons and other evidence, and `outline` shows its structure.',
  hero_rule: 'A big headline with a visual is only a hero when it opens the page. Further down, the same shape is a feature section.',
} as const

export interface FamilyReading {
  value: Family
  confidence: number | null
  probability: number // summed probability of the family's types
}

// Sums type probabilities per family. Confidence uses the same formula as a choice over the families.
export function rollUpFamily(probabilities: Record<string, number> | undefined): FamilyReading | null {
  if (!probabilities) return null
  const mass = Object.fromEntries(Object.keys(FAMILIES).map((family) => [family, 0])) as Record<Family, number>
  for (const [type, p] of Object.entries(probabilities)) if (Number.isFinite(p)) mass[familyOf(type)] += p
  const [value, probability] = (Object.entries(mass) as [Family, number][]).reduce((best, entry) => (entry[1] > best[1] ? entry : best))
  return { value, probability, confidence: choiceConfidence(mass, Object.keys(FAMILIES).length) }
}

// The most likely types inside one family, for the prompt when the family is sure and the type is not.
export function topTypes(probabilities: Record<string, number> | undefined, family: Family, count = 3): { type: string; probability: number }[] {
  if (!probabilities) return []
  return Object.entries(probabilities)
    .filter(([type, p]) => familyOf(type) === family && Number.isFinite(p) && p >= 0.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([type, probability]) => ({ type, probability }))
}
