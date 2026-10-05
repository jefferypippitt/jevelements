// Classifies a captured section with Jev and turns the answers into extra instructions for the
// rebuild prompt. Jev answers typed questions (choice / score / noul); it does not write free
// text, so the prompt wording below is ours.
//
// Primary path is the TypeSafe SDK (TYPESAFE_API_KEY). If that key is missing or the request
// fails, the same questions go through Vercel AI Gateway (AI_GATEWAY_API_KEY).
import { experimental_evaluate as evaluate } from 'ai'
import { APIUserAbortError, choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk'
import { captureState, type Capture, type CaptureState } from './capture'
import {
  CHOICE_ACT,
  describeGroup,
  FEATURE_REVIEW,
  featureBand,
  findSiblingGroups,
  NAME_CONFIDENCE,
  pascalComponent,
  choiceConfidence,
  type SiblingGroup,
} from './judgment'

const GATEWAY_MODEL = 'typesafe-ai/jev'
const TYPESAFE_TIMEOUT_MS = 15_000

const SECTION_TYPE = {
  instructions: 'What kind of website section is `captured`? Judge it from `outline` and `signals`.',
  criteria: {
    navbar: 'Top navigation bar with logo and links',
    hero: 'Large introductory section with a headline and call to action',
    features: 'Grid or list describing product features or benefits',
    pricing: 'Pricing plans or tiers',
    testimonials: 'Customer quotes or reviews',
    faq: 'Frequently asked questions',
    cta: 'Standalone call-to-action banner',
    'logo-cloud': 'Row or grid of customer or partner logos',
    stats: 'Key numbers or metrics',
    'blog-list': 'List or grid of articles or posts',
    'contact-form': 'Form for contacting or signing up',
    footer: 'Page footer with links and legal info',
    card: 'A single card or small component',
    other: 'None of the above',
  },
} as const

const LAYOUT = {
  instructions: 'What is the main layout pattern of this section? Judge it from `outline`.',
  criteria: {
    'centered-stack': 'Content stacked vertically and centered',
    'two-column-split': 'Two columns side by side, e.g. text beside an image',
    'card-grid': 'A grid of repeated cards or tiles',
    'horizontal-row': 'Items in a single horizontal row',
    sidebar: 'A narrow sidebar next to main content',
    layered: 'Overlapping layers, e.g. text over a background image or absolutely positioned decorations',
    other: 'None of the above',
  },
} as const

const THEME = {
  instructions: 'What is the overall color theme of this section? Judge it from `outline`.',
  criteria: {
    light: 'Light background with dark text',
    dark: 'Dark background with light text',
    colorful: 'Saturated or gradient backgrounds',
  },
} as const

const SCOPE = {
  instructions: 'How much of the page is inside `captured`? Judge it from `outline`.',
  criteria: {
    'single-section': 'One coherent page section, such as a hero, a pricing block, or a footer',
    'multi-section': 'Several distinct sections stacked together, such as a hero followed by a feature grid',
    'whole-page': 'Most or all of the page, including navigation and a footer, or many unrelated regions',
  },
} as const

const COLLAPSE = {
  instructions:
    'Assume this section has no responsive CSS. How should the layout in `outline` behave on a narrow screen?',
  criteria: {
    stack: 'Columns or a side-by-side split should stack vertically',
    'horizontal-scroll': 'A row of logos, cards, or a marquee should scroll sideways instead of stacking',
    'hide-secondary': 'A secondary column, sidebar, or decorative media can hide, leaving the primary content',
    'keep-layout': 'The layout is already one column, or stacking would break a table, marquee, or tightly composed graphic',
  },
} as const

const REPEATED = {
  instructions:
    'Which entry in `siblingGroups` is the repeated content template (cards, tiers, logos, posts)? Choose none when the repeats are navigation links, dots, or unrelated elements.',
} as const

const COMPLEXITY = {
  instructions: 'How complex is this section to rebuild faithfully? Judge it from `outline` and `signals`.',
  criteria: [
    'Simple static block',
    'Moderate: several elements, basic hover states',
    'Complex: many parts or layered layout',
    'Very complex: interactive widgets or heavy animation',
  ],
} as const

const NOULS = {
  hasCarousel: 'Does the section contain a carousel, slider, or horizontally scrolling track? Judge it from `outline` and `signals`.',
  hasTabs: 'Does the section contain tabs that switch between panels of content? Judge it from `outline` and `signals`.',
  hasAccordion: 'Does the section contain expandable/collapsible items such as an accordion or FAQ toggles? Judge it from `outline` and `signals`.',
  hasForm: 'Does the section contain form inputs (text fields, selects, checkboxes)? Judge it from `outline`.',
  hasDropdown: 'Does the section contain dropdown or flyout menus? Judge it from `outline` and `signals`.',
  hasMobileMenu: 'Does the section contain a hamburger or mobile menu toggle button? Judge it from `outline`.',
  isSticky: 'Is the section (or a major part of it) sticky or fixed to the viewport? Judge it from `outline` and `signals`.',
  hasBackgroundMedia: 'Is there an image, video, or gradient layered behind the main content? Judge it from `outline`.',
  hasAnimation: 'Do elements animate (keyframe animations, marquee, entrance effects) beyond simple hover transitions? Judge it from `outline` and `signals`.',
} as const

type NoulId = keyof typeof NOULS
type ScopeValue = keyof typeof SCOPE.criteria

const questions = {
  sectionType: choice(SECTION_TYPE.instructions, SECTION_TYPE.criteria),
  layout: choice(LAYOUT.instructions, LAYOUT.criteria),
  theme: choice(THEME.instructions, THEME.criteria),
  scope: choice(SCOPE.instructions, SCOPE.criteria),
  collapse: choice(COLLAPSE.instructions, COLLAPSE.criteria),
  complexity: score(COMPLEXITY.instructions, COMPLEXITY.criteria),
  hasCarousel: noul(NOULS.hasCarousel),
  hasTabs: noul(NOULS.hasTabs),
  hasAccordion: noul(NOULS.hasAccordion),
  hasForm: noul(NOULS.hasForm),
  hasDropdown: noul(NOULS.hasDropdown),
  hasMobileMenu: noul(NOULS.hasMobileMenu),
  isSticky: noul(NOULS.isSticky),
  hasBackgroundMedia: noul(NOULS.hasBackgroundMedia),
  hasAnimation: noul(NOULS.hasAnimation),
}

// The AI Gateway adapter names the yes/no primitive "boolean" and returns `probability`.
const gatewayQuestions = {
  sectionType: { type: 'choice' as const, instructions: SECTION_TYPE.instructions, criteria: SECTION_TYPE.criteria },
  layout: { type: 'choice' as const, instructions: LAYOUT.instructions, criteria: LAYOUT.criteria },
  theme: { type: 'choice' as const, instructions: THEME.instructions, criteria: THEME.criteria },
  scope: { type: 'choice' as const, instructions: SCOPE.instructions, criteria: SCOPE.criteria },
  collapse: { type: 'choice' as const, instructions: COLLAPSE.instructions, criteria: COLLAPSE.criteria },
  complexity: { type: 'score' as const, instructions: COMPLEXITY.instructions, criteria: COMPLEXITY.criteria },
  hasCarousel: { type: 'boolean' as const, instructions: NOULS.hasCarousel },
  hasTabs: { type: 'boolean' as const, instructions: NOULS.hasTabs },
  hasAccordion: { type: 'boolean' as const, instructions: NOULS.hasAccordion },
  hasForm: { type: 'boolean' as const, instructions: NOULS.hasForm },
  hasDropdown: { type: 'boolean' as const, instructions: NOULS.hasDropdown },
  hasMobileMenu: { type: 'boolean' as const, instructions: NOULS.hasMobileMenu },
  isSticky: { type: 'boolean' as const, instructions: NOULS.isSticky },
  hasBackgroundMedia: { type: 'boolean' as const, instructions: NOULS.hasBackgroundMedia },
  hasAnimation: { type: 'boolean' as const, instructions: NOULS.hasAnimation },
}

const GUIDANCE: Record<NoulId, string> = {
  hasCarousel:
    'It contains a carousel/slider. Implement slide navigation (prev/next controls and dots if present), touch/drag support, and keyboard access. Only the slides visible at capture time were recorded; repeat the same slide pattern for the rest.',
  hasTabs:
    'It contains tabs. Implement working tab switching with role="tablist"/"tab"/"tabpanel". Only the active panel was captured, so give the other panels placeholder content in the same format.',
  hasAccordion:
    'It contains expandable items. Implement expand/collapse with an animated height transition and aria-expanded. Collapsed panels may be missing from the capture; use placeholder text in the same style.',
  hasForm:
    'It contains a form. Recreate every field with the same labels, placeholders, and input types. Add client-side validation with React state, with no real submission endpoint.',
  hasDropdown:
    'It contains dropdown/flyout menus. Their hidden contents were not captured. Implement open/close on hover and click, with placeholder items styled like the visible menu.',
  hasMobileMenu:
    'It has a mobile menu toggle. Implement the hamburger button and a slide-down or overlay menu for small screens.',
  isSticky:
    'It is sticky or fixed. Preserve the positioning, z-index, and any background or blur that appears while scrolling.',
  hasBackgroundMedia:
    'Media or gradients sit behind the content. Layer them with absolute positioning (inset: 0; object-fit: cover) under a relatively positioned content wrapper.',
  hasAnimation:
    'Elements animate. Reproduce the animations using the keyframes and transitions in this spec, and respect prefers-reduced-motion.',
}

const REVIEW: Record<NoulId, string> = {
  hasCarousel: 'A carousel or slider may be present. Add slide navigation only where the structure shows one. Do not invent slides, dots, or controls.',
  hasTabs: 'Tabs may be present. Add tab switching only where the structure shows panels. Do not invent extra panels.',
  hasAccordion: 'Expandable items may be present. Add expand/collapse only where the structure shows it. Do not invent collapsed panels.',
  hasForm: 'A form may be present. Recreate a field only when the structure shows that field. Do not invent inputs or validation.',
  hasDropdown: 'A dropdown or flyout may be present. Add open/close only where the structure shows a menu. Do not invent menu items.',
  hasMobileMenu: 'A mobile menu toggle may be present. Add it only where the structure shows a menu button. Do not invent menu items.',
  isSticky: 'Part of this section may be sticky or fixed. Preserve that positioning only where the structure shows it.',
  hasBackgroundMedia: 'Media or a gradient may sit behind the content. Layer it only where the structure shows a background.',
  hasAnimation: 'Some elements may animate. Reproduce an animation only where this spec records one, and respect prefers-reduced-motion.',
}

const SCOPE_ACT: Record<Exclude<ScopeValue, 'single-section'>, string> = {
  'multi-section':
    'This capture stacks several distinct sections. Split it into one component per region, in document order, and compose them on the home page.',
  'whole-page':
    'This capture is most of the page. Split it into one component per region (navigation, each content band, footer), in document order, and compose them on the home page.',
}

export interface ChoiceReading {
  value: string
  confidence: number | null
}

export interface SectionAnalysis {
  model: string
  sectionType: ChoiceReading
  layout: ChoiceReading
  theme: ChoiceReading
  scope: ChoiceReading
  collapse: ChoiceReading
  repeatedGroup: { id: string; summary: string; confidence: number | null } | null
  complexity: number // 0–3
  features: Record<string, number> // boolean question id → P(true)
  nameFromType: boolean
  componentName: string | null
  promptSection: string // markdown block the extension inserts into the prompt
}

interface Judgment {
  model: string
  sectionType: ChoiceReading
  layout: ChoiceReading
  theme: ChoiceReading
  scope: ChoiceReading
  collapse: ChoiceReading
  repeatedGroup: ChoiceReading | null
  complexity: number
  features: Record<NoulId, number>
}

export async function analyzeCapture(
  capture: Capture,
  { abortSignal, model = GATEWAY_MODEL }: { abortSignal?: AbortSignal; model?: string } = {},
): Promise<SectionAnalysis> {
  const typeSafeKey = process.env.TYPESAFE_API_KEY?.trim()
  const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim()
  const groups = findSiblingGroups(capture.root)
  const state = captureState(capture, groups.length ? groups.map((group) => `${group.id}: ${describeGroup(group)}`).join('\n') : 'none')
  const repeated = repeatedCriteria(groups)

  if (typeSafeKey) {
    try {
      return await analyzeWithTypeSafe(state, repeated, groups, typeSafeKey, abortSignal)
    } catch (err) {
      if (aborted(err, abortSignal) || !gatewayKey) throw err
      console.warn('[analyze] TypeSafe request failed, falling back to AI Gateway', err)
    }
  }

  if (gatewayKey) return analyzeWithGateway(state, repeated, groups, model, abortSignal)
  throw new Error('Set TYPESAFE_API_KEY in backend/.env (AI_GATEWAY_API_KEY is the fallback)')
}

function stateRecord(state: CaptureState): Record<string, string> {
  return {
    page: state.page,
    captured: state.captured,
    signals: state.signals,
    siblingGroups: state.siblingGroups,
    outline: state.outline,
  }
}

function repeatedCriteria(groups: SiblingGroup[]): Record<string, string> | null {
  if (!groups.length) return null
  return {
    none: 'No repeated content template. The similar siblings are navigation, controls, or unrelated elements.',
    ...Object.fromEntries(groups.map((group) => [group.id, describeGroup(group)])),
  }
}

async function analyzeWithTypeSafe(
  state: CaptureState,
  repeated: Record<string, string> | null,
  groups: SiblingGroup[],
  apiKey: string,
  abortSignal?: AbortSignal,
): Promise<SectionAnalysis> {
  const client = new TypeSafeClient({
    apiKey,
    timeout: TYPESAFE_TIMEOUT_MS,
    retry: { maxRetries: 0 },
  })
  const asked = repeated ? { ...questions, repeatedGroup: choice(REPEATED.instructions, repeated) } : questions
  const { answers, model } = await client.systemOne(
    { state: stateRecord(state), questions: asked },
    { signal: abortSignal, timeout: TYPESAFE_TIMEOUT_MS },
  )
  const features = Object.fromEntries((Object.keys(NOULS) as NoulId[]).map((id) => [id, answers[id].noul])) as Record<NoulId, number>
  const repeatedAnswer = 'repeatedGroup' in answers ? answers.repeatedGroup : null

  return finish(
    {
      model,
      sectionType: { value: answers.sectionType.choice, confidence: answers.sectionType.confidence },
      layout: { value: answers.layout.choice, confidence: answers.layout.confidence },
      theme: { value: answers.theme.choice, confidence: answers.theme.confidence },
      scope: { value: answers.scope.choice, confidence: answers.scope.confidence },
      collapse: { value: answers.collapse.choice, confidence: answers.collapse.confidence },
      repeatedGroup: repeatedAnswer ? { value: repeatedAnswer.choice, confidence: repeatedAnswer.confidence } : null,
      complexity: answers.complexity.score,
      features,
    },
    groups,
  )
}

type GatewayChoice = { choice: string; probabilities?: Record<string, number> }

async function analyzeWithGateway(
  state: CaptureState,
  repeated: Record<string, string> | null,
  groups: SiblingGroup[],
  model: string,
  abortSignal?: AbortSignal,
): Promise<SectionAnalysis> {
  const asked = repeated
    ? { ...gatewayQuestions, repeatedGroup: { type: 'choice' as const, instructions: REPEATED.instructions, criteria: repeated } }
    : gatewayQuestions
  const { answers, response } = await evaluate({
    model,
    state: stateRecord(state),
    questions: asked,
    abortSignal,
  })
  const picked = (answer: GatewayChoice, optionCount: number): ChoiceReading => ({
    value: answer.choice,
    confidence: choiceConfidence(answer.probabilities, optionCount),
  })
  const features = Object.fromEntries((Object.keys(NOULS) as NoulId[]).map((id) => [id, answers[id].probability])) as Record<NoulId, number>

  return finish(
    {
      model: response.modelId || model,
      sectionType: picked(answers.sectionType, Object.keys(SECTION_TYPE.criteria).length),
      layout: picked(answers.layout, Object.keys(LAYOUT.criteria).length),
      theme: picked(answers.theme, Object.keys(THEME.criteria).length),
      scope: picked(answers.scope, Object.keys(SCOPE.criteria).length),
      collapse: picked(answers.collapse, Object.keys(COLLAPSE.criteria).length),
      repeatedGroup: repeated && 'repeatedGroup' in answers ? picked(answers.repeatedGroup, Object.keys(repeated).length) : null,
      complexity: answers.complexity.score,
      features,
    },
    groups,
  )
}

function finish(judgment: Judgment, groups: SiblingGroup[]): SectionAnalysis {
  const severalRegions = judgment.scope.value !== 'single-section' && (judgment.scope.confidence ?? 0) >= CHOICE_ACT
  const nameFromType = !severalRegions && judgment.sectionType.value !== 'other' && (judgment.sectionType.confidence ?? 0) >= NAME_CONFIDENCE
  const repeated = resolveRepeated(judgment.repeatedGroup, groups)
  const analysis: Omit<SectionAnalysis, 'promptSection'> = {
    ...judgment,
    repeatedGroup: repeated,
    nameFromType,
    componentName: nameFromType ? pascalComponent(judgment.sectionType.value) : null,
  }
  return { ...analysis, promptSection: renderPromptSection(analysis) }
}

function resolveRepeated(answer: ChoiceReading | null, groups: SiblingGroup[]): SectionAnalysis['repeatedGroup'] {
  if (!answer || answer.value === 'none') return null
  const group = groups.find((candidate) => candidate.id === answer.value)
  if (!group) return null
  return { id: group.id, summary: describeGroup(group), confidence: answer.confidence }
}

function aborted(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (err instanceof APIUserAbortError) return true
  return err instanceof Error && err.name === 'AbortError'
}

function confidenceNote(confidence: number | null) {
  return confidence === null ? '' : ` (${Math.round(confidence * 100)}% confidence)`
}

function likelyNote(probability: number) {
  return ` (${Math.round(probability * 100)}% likely)`
}

function isScope(value: string): value is ScopeValue {
  return value === 'single-section' || value === 'multi-section' || value === 'whole-page'
}

function renderPromptSection(analysis: Omit<SectionAnalysis, 'promptSection'>): string {
  const lines = ['## Section analysis', typeLine(analysis), layoutLine(analysis), `- Theme: ${analysis.theme.value}${confidenceNote(analysis.theme.confidence)}`]

  const scopeLine = scopeInstruction(analysis.scope)
  if (scopeLine) lines.push(scopeLine)

  lines.push(`- Complexity: ${analysis.complexity.toFixed(1)} / 3`)

  const repeatedLine = repeatedInstruction(analysis.repeatedGroup)
  if (repeatedLine) lines.push(repeatedLine)

  const act = (Object.keys(NOULS) as NoulId[]).filter((id) => featureBand(analysis.features[id] ?? 0) === 'act')
  const review = (Object.keys(NOULS) as NoulId[]).filter((id) => featureBand(analysis.features[id] ?? 0) === 'review')
  if (act.length) {
    lines.push('', '### Behaviour to implement')
    for (const id of act) lines.push(`- ${GUIDANCE[id]}${likelyNote(analysis.features[id] ?? 0)}`)
  }
  if (review.length) {
    lines.push('', '### Uncertain behaviour', 'These may be present. Follow the measured structure. Do not add them unless the spec shows them.')
    for (const id of review) lines.push(`- ${REVIEW[id]}${likelyNote(analysis.features[id] ?? 0)}`)
  }
  if (analysis.complexity >= 2) {
    lines.push('', 'This is a complex section. Split it into small subcomponents, one per repeated or interactive part, and keep the shared data (items, links, copy) in arrays at the top of the file.')
  }
  return lines.join('\n')
}

function typeLine(analysis: Omit<SectionAnalysis, 'promptSection'>): string {
  const note = confidenceNote(analysis.sectionType.confidence)
  if (analysis.nameFromType && analysis.componentName) {
    return `- Type: **${analysis.sectionType.value}**${note}. Name the component \`${analysis.componentName}\`.`
  }
  if (analysis.scope.value !== 'single-section' && (analysis.scope.confidence ?? 0) >= CHOICE_ACT) {
    return `- Type: **${analysis.sectionType.value}**${note}. This label describes the capture overall. Name each region from its own contents.`
  }
  return `- Type: **${analysis.sectionType.value}**${note}. Name the component from the captured element's id, class, or tag, as in **Stack & output**.`
}

function layoutLine(analysis: Omit<SectionAnalysis, 'promptSection'>): string {
  const note = confidenceNote(analysis.layout.confidence)
  const caution = (analysis.layout.confidence ?? 0) < CHOICE_ACT ? ' Follow the measured tree when it disagrees with this label.' : ''
  return `- Layout pattern: ${analysis.layout.value}${note}.${caution}`
}

function scopeInstruction(scope: ChoiceReading): string | null {
  if (!isScope(scope.value) || scope.value === 'single-section') return null
  if ((scope.confidence ?? 0) >= CHOICE_ACT) return `- Scope: ${SCOPE_ACT[scope.value]}`
  if ((scope.confidence ?? 0) >= FEATURE_REVIEW) {
    return '- Scope: this capture may contain more than one section. Split it only where the tree shows a clear break between regions.'
  }
  return null
}

function repeatedInstruction(group: SectionAnalysis['repeatedGroup']): string | null {
  if (!group) return null
  if ((group.confidence ?? 0) >= CHOICE_ACT) {
    return `- Repeated items: ${group.summary} Put that group's text and media in an array and render one child component per item.`
  }
  if ((group.confidence ?? 0) >= FEATURE_REVIEW) {
    return `- Repeated items: this may be the template — ${group.summary} Use an array only if those siblings are the same kind of content. Do not invent extra items.`
  }
  return null
}
