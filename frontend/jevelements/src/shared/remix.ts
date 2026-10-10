// The remix half of the prompt (REMIX.md): the same capture and spec as PROMPT.md, and the same
// foundations (text, assets, fonts, colors, each element's styling), rebuilt in a new layout.
// A remix is a "shuffle": one or two named layout moves (a centered header moved to the side, a grid
// turned into a bento or a marquee), never a re-skin, chosen from the moves that suit this kind of
// section (remix-moves.ts). buildPrompt(capture, 'remix') puts these sections where the clone's task
// and checklist go; the measured spec in between is shared.
import { componentNames, kitBase } from './kit'
import { type Move, playbookFor, type RemixPlan, remixPlan, TYPE_PLAYBOOKS } from './remix-moves'
import type { Capture, CapturedNode } from './types'

export type PromptMode = 'clone' | 'remix'

// The brief comes first so the user can fill it in before sending REMIX.md. Left as it is, the agent
// picks the moves from the ones that fit this section, builds without asking, and keeps the palette
// and type. Scope `style` is the one opt-in past a shuffle: it swaps colors and typefaces by role.
export function remixTask(capture: Capture, project: string): string {
  const plan = remixPlan(capture)
  return `# Task: Remix this UI section's layout

You are rebuilding a UI section captured from a live website as its own **Next.js app** named \`${project}\` (see **Step 1** and **Stack & output**), in a **new layout**. Everything after **How to remix** is the measured spec of the original, the same spec as the 1:1 rebuild in PROMPT.md.

A remix is a shuffle, not a redesign. The foundations stay exactly as the spec has them: every word of text, every image, video and SVG, the fonts, the colors, and how each element and item looks (its type, surface, padding, border, radius, shadow, hover). What changes is the arrangement: one or two **layout moves** from **How to remix**, chosen for the kind of section this is. A testimonials grid might get its centered header moved into a left column and its cards into a bento grid; a hero might get its headline and actions split into an asymmetric composition. Someone who knows the original should recognize every piece and see it arranged in a new way. Only when the brief sets **Scope** to \`style\` do the palette and typefaces change too (see **Scope: style**).

## Your brief
Edit these lines before sending. A line left as it is means: decide it yourself.

- **Move:** auto (one of this section's moves; on a later round, one no earlier round used. Or the id of a move from **Layout moves**, or a header move and an items or section move joined with \`+\`, e.g. \`side-header + bento\`)
- **Notes:** none (anything else about the layout, e.g. "marquee scrolls right", "feature the third item")
- **Preview:** off (\`on\`: before building, propose three moves or pairings for this round, one line each, and wait for the user to pick one)
- **Scope:** layout (\`layout\`: only the arrangement changes. \`style\`: the palette and typefaces change as well, from the two lines below)
- **Palette:** keep (with Scope \`style\`: the new colors, as hex values or in words, e.g. "warm neutrals, one terracotta accent")
- **Type:** keep (with Scope \`style\`: the new typeface, e.g. a Google Fonts name or "a geometric sans")

${briefMoves(plan)}`
}

// The move ids, right under the brief, so the user can pick one without scrolling to **Layout moves**.
function briefMoves(plan: RemixPlan): string {
  if (plan.section && plan.playbook) return `This section's moves, best first: ${ids(plan.offered)}. Each one is described under **Layout moves**.`
  if (plan.section) return `The moves this section's shape carries: ${plan.fit.length ? ids(plan.fit) : 'none matched automatically'}. Each one is described under **Layout moves**.`
  return `This section isn't classified yet, so its moves depend on its row in **Section playbooks**. By shape alone it could carry ${plan.fit.length ? ids(plan.fit) : 'none of them automatically'}.`
}

export function remixGuide(capture: Capture): string {
  const dna = designDna(capture)
  const plan = remixPlan(capture)
  const { file, component } = componentNames(kitBase(capture))
  return `## How to remix
${sectionBlock(plan)}

### What stays and what moves
Exactly as in the spec (as a 1:1 rebuild would have it):
- **Content:** every text string, as written, and the same items in the same order. No item added, dropped, merged or shortened.
- **Assets:** every image, video, SVG and canvas, from the same files, at the same crop and aspect ratio.
- **Typography and color:** the same font files, sizes, weights, line-heights and letter-spacing; the same colors, gradients and backgrounds. No new color, typeface or font size (with **Scope** \`style\`, see **Scope: style**).
- **The look of each element and item:** its surface, padding inside it, border, radius, shadow, and its hover, focus and click states.
- **The section's frame:** its background, its outer padding, its theme and dark-mode switching.
- **Behaviour:** every animation, scroll effect and interaction in the spec still works on the element it belongs to.

What the move changes, and only that:
- **The arrangement:** the layout of the section and its containers (display, grid and flex, columns, column and row spans, direction, alignment, text-align of the heading block, the order things sit in on screen) and the size of a cell the move enlarges.
- **The motion the move brings** (a marquee's scroll, a carousel's snap, a pin), and the few controls it needs (carousel buttons, tabs), built only from the section tokens below.

### Work in four passes
1. **Read.** ${plan.sure ? 'Start from the section\'s job (see **This section**)' : 'Decide what section this is (see **This section**) and write its job in one sentence, for yourself'}. Read \`remix-log.md\` if it exists (see **Another round**). Then choose the move or moves, from the brief or, on auto, from this section's moves under **Layout moves**: the one that best serves its job and changes the arrangement visibly. Never a move that describes the original's current arrangement (a grid that is already a bento can't get \`bento\`). Use at most one header move and one items or section move. If the brief's **Preview** is \`on\`, stop here: list three moves or pairings this round could use, one line each with why it suits the section, and wait for the user to pick one (or name their own) before building anything.
2. **Build the pieces 1:1.** The 1:1 pieces are the item components and the heading block in \`components/\`, exactly as the spec describes. If the clone from PROMPT.md or an earlier round already built them, reuse them untouched. Otherwise build them as PROMPT.md would.
3. **Rearrange.** Write this round's layout in \`components/remix-<n>/${file}.tsx\`, exporting \`${component}Remix<n>\` (<n> is this round's number, 1 for the first), which renders the 1:1 pieces in the new arrangement. Change only the containers, as the move says, using spacing, radius and color values from **Section tokens**. Build the move's small-screen behaviour too. Point \`app/page.tsx\` at this round, add it to \`app/rounds/page.tsx\`, and add its entry to \`remix-log.md\`.
4. **Inspect and revise.** Run \`npm run dev\` and, if you can open a browser, screenshot the section at ${capture.viewport.w}px and at 375px wide, saved as \`remix-shots/<n>-desktop.png\` and \`remix-shots/<n>-mobile.png\` in the app's root. Compare one item up close with the original's screenshot (it should match), then the whole section (the arrangement should not). Run every check in **Acceptance checklist** and fix what fails. Keep this pass internal: deliver the section and the summary.

### Another round
The user may send this prompt again, or ask in the same chat for "another one", "try again" or "something else". Each round is a new layout of the same 1:1 pieces, never a layer on top of the last round.
- **The log.** \`remix-log.md\` in the app's root keeps one line per round, oldest first: \`<n>. <moves> | components/remix-<n>/ | <why, in a few words> | <screenshots>\` (e.g. \`1. side-header + bento | components/remix-1/ | quotes read as a wall, first one featured | remix-shots/1-desktop.png, remix-shots/1-mobile.png\`; \`none\` for the screenshots when you couldn't open a browser). Add the scope when it is \`style\` (e.g. \`2. marquee, style: warm neutrals + Fraunces | …\`). Create it on the first round. The round number is one more than the last line's.
- **Choosing.** A move the user names is built, even if the log has it (e.g. "use marquee", "keep the header from round 2 and try masonry"). Otherwise, choose from this section's moves that no earlier round used; a different header and items pairing counts as new. If every one is used, say so and offer the user the best pairings again rather than reaching for a move that doesn't suit this kind of section.
- **Starting point.** Always the 1:1 pieces in their original look, never a previous round's files. Leave earlier rounds' folders as they are, so the user can switch back by pointing \`app/page.tsx\` at one.
- **Comparing rounds.** \`app/rounds/page.tsx\` (served at \`/rounds\`) renders every round, newest first, one under the other, each headed by its log line in a small caption styled from the section tokens. Create it on the first round and add each new round to it; \`app/page.tsx\` still renders only the current round.

### Scope: style (only when the brief sets it)
With **Scope** \`style\`, the palette and typefaces change as well as the arrangement. Everything else in **What stays and what moves** holds.
- **Palette.** Map the brief's palette onto the color roles in **Section tokens**: one new value per role (background, surfaces, text, muted text, accents, borders). Keep each role's contrast with what sits on it (body text at least 4.5:1). A role the brief doesn't cover keeps its original value. Define the new values once as CSS variables in \`app/globals.css\` and use only those. Gradients keep their stops' roles, in the new colors. With dark mode, map the dark values too.
- **Type.** The brief's typeface replaces the original families: load it with \`next/font/google\` (or from files the user gives you). Sizes, weights, line-heights and letter-spacing stay as measured, so the hierarchy holds. A monospace or icon font stays as it is.
- **Still unchanged:** every word, image, video and SVG artwork, the radii, shadows, border widths, spacing and motion. An SVG drawn in \`currentColor\` follows the new text color; one with fixed colors stays as it is.
- **Palette: keep** or **Type: keep** means that half stays original.

${movesBlock(plan)}

### Section tokens (the values new layout and controls may use)
Read from the captured styles. A gap, size or color the move needs comes from these, never a new value.

${dna.lines.join('\n\n')}

### Reading the spec below
It describes the original, measured, in its original arrangement.
- **Structure & exact styles**: the styles of every element hold, exactly. The layout lines of the section and its containers (display, grid or flex, widths, positions, alignment) describe the arrangement the move replaces.
- **Structure & Parts**: keep the semantic structure, the component split and the names. A move may add wrappers or a controls component, in its round's folder (e.g. \`components/remix-<n>/carousel-controls.tsx\`).
- **Responsive behavior**: the original's breakpoints are where the move's own small-screen layout kicks in.
- **Motion, scroll story and interactions**: keep every one. When the move animates something that already moves (a marquee of items that fade in on scroll), the item's own effect plays inside the move's.

### Don't
- re-skin: no new palette, typeface, font size, radius, shadow or border on anything the original styles (with **Scope** \`style\`, only the brief's palette and typeface, mapped by role)
- rewrite, shorten or reorder the copy, or drop items to make a layout fit (a bento with 5 items fills 5 cells)
- add decoration: badges, pills, icons, gradients, glows, blur, noise or extra accents the original doesn't have (a move's controls, a marquee's edge mask and a wall's fade are the only additions)
- crop, recolor or swap an image to suit the new cell
- change more than the moves you named

Finish with a summary: the round number, the kind of section, the move or moves and why they suit the section, the scope (and, with \`style\`, the colors and typeface you mapped), how the layout behaves at each breakpoint, anything you added for the move (controls, wrappers), and where to see it (\`/\` for this round, \`/rounds\` for all of them).`
}

const human = (name: string) => name.replace(/-/g, ' ')
const ids = (moves: Move[]) => moves.map((m) => `\`${m.id}\``).join(', ')

function shapeLine({ shape }: RemixPlan): string {
  const items = shape.items ? `${shape.items}× \`${shape.item}\`${shape.columns ? `, about ${shape.columns} per row` : ''}${shape.media ? ', each with media' : ''}` : 'no repeated items'
  return `Its content: ${items}; ${shape.header ? 'a heading block' : 'no heading block'}.`
}

// What the section is comes first: it decides which moves are on the table.
function sectionBlock(plan: RemixPlan): string {
  const { section, playbook } = plan
  if (section && playbook) {
    const family = TYPE_PLAYBOOKS[section]?.family
    return `### This section
A **${human(section)}** section${family && family !== section ? ` (${human(family)})` : ''}, from the capture's analysis. A reader comes here to ${playbook.job}. ${shapeLine(plan)}

For this kind of section, on top of the foundations below:
${playbook.keep.map((k) => `- ${k}`).join('\n')}`
  }
  if (section) {
    return `### This section
A **${human(section)}** section, from the capture's analysis. No playbook covers it, so its shape decides the moves. ${shapeLine(plan)} Write its job in one sentence, for yourself, before choosing.`
  }
  return `### This section
${plan.guess ? `The capture's analysis leans towards **${human(plan.guess)}** but isn't sure.` : "The capture wasn't classified."} Before anything else, decide what this section is from the screenshot and the tree: pick its row in **Section playbooks** below (\`other\` when none matches), name it at the top of your summary, and from then on use only that row's moves, never list and keep rules. ${shapeLine(plan)}`
}

function describe(moves: Move[]): string {
  return moves.map((m) => `- **\`${m.id}\`: ${m.name}** (${m.kind}; fits ${m.when}). ${m.does}\n  - Build: ${m.build}`).join('\n')
}

function movesBlock(plan: RemixPlan): string {
  const { section, playbook } = plan
  if (section && playbook) {
    const narrowed = plan.fit.length < plan.offered.length ? ` Of those, its content carries ${ids(plan.fit)}.` : ''
    const never = plan.never.length ? `\n\n**Never for a ${human(section)} section:** ${ids(plan.never)}: ${playbook.why}. A move the user names is still built; if it's one of these, say in your summary what it costs the section.` : ''
    return `### Layout moves
The moves for a ${human(section)} section, best first: ${ids(plan.offered)}.${narrowed} Choose from these.${never}

${describe(plan.offered)}`
  }
  if (section) {
    return `### Layout moves
The moves its shape carries: ${plan.fit.length ? ids(plan.fit) : 'none matched automatically, so choose the closest'}.

${describe(plan.offered)}`
  }
  const rows = Object.keys(TYPE_PLAYBOOKS).map((type) => {
    const p = playbookFor(type)!
    const never = p.never.length ? ` Never: ${p.never.map((id) => `\`${id}\``).join(', ')} (${p.why}).` : ''
    return `- **${type}** (${human(TYPE_PLAYBOOKS[type].family)}): to ${p.job}. Moves: ${p.moves.map((id) => `\`${id}\``).join(', ')}.${never} Keep: ${p.keep.join(' ')}`
  })
  return `### Section playbooks
One row per kind of section: what a reader does there, its moves (best first), the moves that break it, and what holds on top of the foundations.
${rows.join('\n')}
- **other**: no playbook. Any move below that its shape carries, except \`nav-arrange\` and \`footer-arrange\`.

### Layout moves
By shape alone, this section could carry ${plan.fit.length ? ids(plan.fit) : 'none of them automatically'}; use only the ones in the row you chose.

${describe(plan.offered)}`
}

export function remixChecklist(capture: Capture, project: string): string {
  const dna = designDna(capture)
  const reflexes = reflexPatterns(dna)
  const plan = remixPlan(capture)
  const section = plan.section
    ? `- [ ] The moves are ${plan.playbook ? `among the moves for a ${human(plan.section)} section` : 'ones its shape carries'}, or the ones the user named.${plan.playbook?.keep.map((k) => `\n- [ ] ${k}`).join('') ?? ''}`
    : '- [ ] The summary names the kind of section you decided on, the moves come from its row in **Section playbooks** (or the user named them), and that row\'s keep rules hold.'
  return `## Acceptance checklist
${section}
- [ ] Side by side with the original's screenshot at ${capture.viewport.w}px wide, the arrangement is visibly different, as the named move or moves describe, and nothing else is.
- [ ] Up close, an item looks exactly like the original's: the same type, colors, surface, padding, border, radius, shadow and media crop (with Scope \`style\`, in the brief's colors and typeface, mapped by role).
- [ ] Every text string in the spec appears, unchanged, and every item is there, in the original order (a marquee's hidden copy aside).
- [ ] Every image, video and SVG comes from the spec's files, at the original crop and aspect ratio. Fonts load from the files under **Fonts**, with no failed font request.
- [ ] No new color, typeface, font size, radius or shadow: every one in \`app/\` and \`components/\` is in the spec (with Scope \`style\`, or is the brief's palette or typeface, defined once in \`app/globals.css\`, with body text at least 4.5:1 against its background).${
    reflexes ? `\n- [ ] No decoration the original doesn't have: \`grep -rnE "${reflexes}" components\` prints nothing, or each hit is the original's or the move's (a marquee's edge mask, a wall's fade).` : ''
  }
- [ ] The section keeps its background and outer padding${dna.padding ? ` (${dna.padding})` : ''}, and nothing touches its edges.
- [ ] Every animation, scroll effect, hover and click from the spec works, and so does the move's own motion. Looping motion has no visible jump, pauses on hover and focus, and stops with prefers-reduced-motion.
- [ ] The move's controls (if any) work with the keyboard and have accessible names.
- [ ] At 375px wide the layout follows the move's small-screen rule, with no horizontal page scroll.
- [ ] With the OS in dark mode, the section switches as the original does.
- [ ] It's a standalone Next.js app in \`${project}/\`: \`npm run build\` passes with no type errors, and \`npm run dev\` shows the section on the home page.
- [ ] This round lives in its own \`components/remix-<n>/\`, uses no file from an earlier round, has its line in \`remix-log.md\` (with its screenshots, if you could take them), shows on \`/rounds\` with every earlier round, and is the one \`app/page.tsx\` renders. Without a move named by the user, its moves differ from every earlier round's.
- [ ] The final summary gives the round number, the kind of section, names the moves, why they suit the section, the scope, the breakpoint behaviour and anything added.`
}

// ---------- Section tokens: the original's values by role, read from the captured tree ----------

interface Dna {
  lines: string[]
  padding: string | null // the section's own padding
  has: { uppercase: boolean; gradient: boolean; blur: boolean; shadow: boolean; badge: boolean }
}

interface Effective {
  color: string
  family: string
  size: string
  weight: string
  leading: string
}

const SPACING = /^(padding|margin|gap|row-gap|column-gap)/
const HEX = /#[0-9a-f]{6}(?:[0-9a-f]{2})?\b|#[0-9a-f]{3}\b/gi
const BADGE = /\b(badge|pill|chip|tag)s?\b/i

export function designDna(capture: Capture): Dna {
  const text = new Map<string, { count: number; first: string }>()
  const fills = new Map<string, { count: number; area: number; first: string }>()
  const borders = new Map<string, number>()
  const type = new Map<string, { count: number; first: string; px: number }>()
  const families = new Set<string>()
  const radii = new Map<string, number>()
  const shadows = new Map<string, number>()
  const spacing = new Set<number>()
  const inventory = { heading: 0, link: 0, button: 0, image: 0, svg: 0, input: 0, text: 0 }
  const has = { uppercase: false, gradient: false, blur: false, shadow: false, badge: false }

  const visit = (node: CapturedNode, parent: Effective) => {
    if (node.hidden) return
    const s = node.styles
    const here: Effective = {
      color: lowerHex(s['color']) ?? parent.color,
      family: s['font-family'] ? firstFamily(s['font-family']) : parent.family,
      size: s['font-size'] ?? parent.size,
      weight: s['font-weight'] ?? parent.weight,
      leading: s['line-height'] ?? parent.leading,
    }
    const name = label(node)
    const area = node.box.w * node.box.h

    const fill = lowerHex(s['background-color'])
    if (fill && !transparent(fill)) {
      const entry = fills.get(fill) ?? { count: 0, area: 0, first: name }
      fills.set(fill, { count: entry.count + 1, area: Math.max(entry.area, area), first: entry.first })
    }
    for (const [prop, value] of Object.entries(s)) {
      if ((prop.startsWith('border') && prop.includes('color')) || /^border(-(top|right|bottom|left))?$/.test(prop)) {
        for (const hex of value.match(HEX) ?? []) if (!transparent(hex.toLowerCase())) borders.set(hex.toLowerCase(), (borders.get(hex.toLowerCase()) ?? 0) + 1)
      }
      if (SPACING.test(prop) && node !== capture.root) for (const px of pxValues(value)) spacing.add(px)
    }
    if (s['border-radius'] && s['border-radius'] !== '0px') radii.set(s['border-radius'], (radii.get(s['border-radius']) ?? 0) + 1)
    if (s['box-shadow'] && s['box-shadow'] !== 'none') {
      has.shadow = true
      shadows.set(s['box-shadow'], (shadows.get(s['box-shadow']) ?? 0) + 1)
    }
    if (/gradient\(/.test(s['background-image'] ?? '')) has.gradient = true
    if (s['text-transform'] === 'uppercase') has.uppercase = true
    if (/blur\(/.test(`${s['backdrop-filter'] ?? ''} ${s['filter'] ?? ''}`)) has.blur = true
    if (BADGE.test((node.classes ?? []).join(' '))) has.badge = true

    const tag = node.tag.toLowerCase()
    if (/^h[1-6]$/.test(tag)) inventory.heading++
    else if (tag === 'a') inventory.link++
    else if (tag === 'button') inventory.button++
    else if (tag === 'img' || tag === 'video' || tag === 'picture' || tag === 'canvas') inventory.image++
    else if (tag === 'svg') inventory.svg++
    else if (tag === 'input' || tag === 'textarea' || tag === 'select') inventory.input++

    if (node.text?.trim()) {
      inventory.text++
      if (here.color) {
        const entry = text.get(here.color) ?? { count: 0, first: name }
        text.set(here.color, { count: entry.count + 1, first: entry.first })
      }
      families.add(here.family)
      const key = `${here.size} / ${here.weight}${here.leading && here.leading !== 'normal' ? ` / line-height ${here.leading}` : ''}`
      const entry = type.get(key) ?? { count: 0, first: name, px: parseFloat(here.size) || 0 }
      type.set(key, { ...entry, count: entry.count + 1 })
    }
    for (const child of node.children) visit(child, here)
  }
  visit(capture.root, { color: '', family: 'the browser default', size: '16px', weight: '400', leading: 'normal' })

  const lines: string[] = []

  // Colors by role: the section's own fill is the background (when it has none, the page behind it is,
  // and only the screenshot shows it); other neutral fills are surfaces; saturated colors are accents.
  const colorRows: string[] = []
  const own = lowerHex(capture.root.styles['background-color'])
  const background = own && !transparent(own) ? own : null
  if (!background) colorRows.push('| background | the page behind the section (not in the capture; read it from the screenshot) | the whole section |')
  const fillList = [...fills.entries()].sort((a, b) => b[1].area - a[1].area)
  const surfaces = fillList.filter(([hex]) => hex !== background && !chromatic(hex)).length
  let surface = 0
  for (const [hex, f] of fillList) {
    const role = hex === background ? 'background' : chromatic(hex) ? 'accent fill' : surfaces > 1 ? `surface ${++surface}` : 'surface'
    colorRows.push(`| ${role} | \`${hex}\` | ${reach(f.count)}, first \`${f.first}\` |`)
  }
  const textList = [...text.entries()].sort((a, b) => b[1].count - a[1].count)
  let muted = 0
  textList.forEach(([hex, t], i) => {
    const role = chromatic(hex) ? 'accent text' : i === 0 ? 'text' : `muted text${++muted > 1 ? ` ${muted}` : ''}`
    colorRows.push(`| ${role} | \`${hex}\` | ${reach(t.count)} with text, first \`${t.first}\` |`)
  })
  for (const [hex, count] of [...borders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) colorRows.push(`| border | \`${hex}\` | ${reach(count)} |`)
  if (colorRows.length) lines.push('**Colors**\n\n| Role | Original | Reach |\n| --- | --- | --- |\n' + colorRows.join('\n'))

  const typeRows = [...type.entries()].sort((a, b) => b[1].px - a[1].px || b[1].count - a[1].count).slice(0, 8)
  if (typeRows.length) {
    lines.push(
      `**Type** (${[...families].map((f) => `**${f}**`).join(', ')}; size / weight, largest first)\n${typeRows.map(([key, t]) => `- ${key}: ${reach(t.count)}, first \`${t.first}\``).join('\n')}`,
    )
  }

  const shape: string[] = []
  const padding = sectionPadding(capture.root.styles)
  if (padding) shape.push(`- Section padding: ${padding}`)
  if (spacing.size) shape.push(`- Spacing steps inside it: ${[...spacing].sort((a, b) => a - b).slice(0, 12).map((n) => `${n}px`).join(', ')}`)
  shape.push(`- Radii: ${radii.size ? [...radii.entries()].map(([r, n]) => `${r} (${reach(n)})`).join(', ') : 'none (square corners)'}`)
  shape.push(`- Shadows: ${shadows.size ? [...shadows.entries()].map(([v, n]) => `\`${v}\` (${reach(n)})`).join(', ') : 'none (flat)'}`)
  shape.push(`- Gradients: ${has.gradient ? 'yes' : 'none'}; blur or glass: ${has.blur ? 'yes' : 'none'}; all-caps text: ${has.uppercase ? 'yes' : 'none'}`)
  lines.push(`**Shape & space**\n${shape.join('\n')}`)

  const repeated = (capture.parts ?? []).flatMap(function walk(p): string[] {
    return [...(p.repeats && p.repeats > 1 ? [`${p.repeats}× \`${p.name}\``] : []), ...(p.parts ?? []).flatMap(walk)]
  })
  const counts = [
    plural(inventory.heading, 'heading'),
    plural(inventory.text, 'text block'),
    plural(inventory.link, 'link'),
    plural(inventory.button, 'button'),
    plural(inventory.image, 'image or video', 'images or videos'),
    plural(inventory.svg, 'SVG'),
    plural(inventory.input, 'form field'),
  ].filter(Boolean)
  lines.push(`**Element inventory**: ${counts.join(', ') || 'no text or media'}${repeated.length ? `; repeated items: ${repeated.join(', ')}` : ''}. Badges, pills or tags: ${has.badge ? 'yes' : 'none'}; icons: ${inventory.svg ? `${inventory.svg} SVG${inventory.svg === 1 ? '' : 's'}` : 'none'}.`)

  return { lines, padding, has }
}

// Class names and utilities that only show up when the remix adds what the original doesn't have.
function reflexPatterns(dna: Dna): string {
  const out: string[] = []
  if (!dna.has.badge) out.push('badge', 'pill', 'chip')
  if (!dna.has.uppercase) out.push('uppercase')
  if (!dna.has.gradient) out.push('gradient')
  if (!dna.has.blur) out.push('blur', 'backdrop')
  if (!dna.has.shadow) out.push('shadow-')
  return out.join('|')
}

function label(node: CapturedNode): string {
  let head = node.tag
  if (node.id) head += `#${node.id}`
  if (node.classes?.length) head += '.' + node.classes.slice(0, 2).join('.')
  return head.length > 60 ? head.slice(0, 60) + '…' : head
}

function lowerHex(value: string | undefined): string | null {
  const m = value?.match(HEX)
  return m ? m[0].toLowerCase() : null
}

function transparent(hex: string): boolean {
  return hex.length === 9 && hex.endsWith('00')
}

// Saturated enough to read as a hue (an accent), not a tinted neutral like a warm off-white.
function chromatic(hex: string): boolean {
  const h = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (c) => c + c) : hex
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  return Math.max(r, g, b) - Math.min(r, g, b) > 64
}

function firstFamily(value: string): string {
  return value.split(',')[0].trim().replace(/^["']|["']$/g, '').slice(0, 60)
}

function pxValues(value: string): number[] {
  return [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Math.round(Number(m[1]))).filter((n) => n > 0)
}

function sectionPadding(styles: Record<string, string>): string | null {
  if (styles['padding']) return styles['padding']
  const sides = ['top', 'right', 'bottom', 'left'].map((side) => styles[`padding-${side}`] ?? '0px')
  return sides.every((v) => v === '0px') ? null : sides.join(' ')
}

function reach(count: number): string {
  return `${count} element${count === 1 ? '' : 's'}`
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count ? `${count} ${count === 1 ? one : many}` : ''
}
