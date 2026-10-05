// Turns a Capture into one markdown prompt for an IDE agent (Claude Code, Cursor, …).
// Every section is markdown: headings, lists, and fenced code. This runs locally today;
// the backend LLM can later refine or replace it using the same Capture JSON.
import { componentNames, kitBase, projectName } from './kit'
import type { Asset, Capture, CapturedNode, CodeRef, Interaction, SectionAnalysis, ShaderSource, TextAnimation } from './types'

// The rebuild always happens in its own Next.js app (App Router, TypeScript, Tailwind CSS): the
// <name>.zip the extension downloads, with the saved files in public/ (see Capture.project). The
// prompt is written for an agent working inside that extracted folder.


function stackSection(kit: string, scope: SectionAnalysis['scope'] | undefined): string {
  const { file, component } = componentNames(kit)
  const severalRegions = !!scope && scope.value !== 'single-section' && (scope.confidence ?? 0) >= COLLAPSE_ACT
  const structure = severalRegions
    ? `- Split the capture into one component per region, in document order, under \`components/\`. Use kebab-case file names and PascalCase exports. Compose those components from the home page, \`app/page.tsx\`.`
    : `- Build the section as \`components/${file}.tsx\` exporting \`${component}\` (replace the placeholder in that file). Name files like shadcn/ui: one component per file, kebab-case file names, PascalCase exports. Split repeated or complex parts into their own files next to it (e.g. \`components/${file}-card.tsx\`).
- Render it from the home page, \`app/page.tsx\`.`
  return `## Stack & output
Always **Next.js** (App Router) with **TypeScript** and **Tailwind CSS v4**, in the app from **Step 1**. Don't detect or adapt to any other framework.

${structure}
- Keep components Server Components and add \`"use client"\` only to the ones that need state, effects or event handlers.
- Style with Tailwind utility classes. When a value is not exactly on Tailwind's scale, use an arbitrary value (e.g. \`text-[56px]\`, \`leading-[64px]\`, \`bg-[#0b0b0f]\`, \`shadow-[0_1px_2px_#0000000d]\`). Never round to the nearest step. Put \`@keyframes\`, \`@font-face\` and anything Tailwind can't express in \`app/globals.css\`.
- Every image, video and other asset lives in \`public/\` and is referenced by its local path (\`/capture/…\`). Never hotlink the original site.
- Install any npm package the spec calls for (\`gsap\`, \`three\`, \`lenis\`, \`motion\`, \`lottie-web\`, …) with \`npm install\`.
- Output only this section, with no page chrome, nav, or footer unless they are part of the captured element.
- Keep the section's text content exactly as written below, including capitalization and punctuation.`
}

// Same floors as backend/src/lib/judgment.ts. A confident collapse replaces the generic stack.
const COLLAPSE_ACT = 0.6
const COLLAPSE_REVIEW = 0.4

function responsiveFallback(collapse: SectionAnalysis['collapse'] | undefined): string {
  const lead =
    'No breakpoint rules targeting this section could be read. Keep the layout fluid: use max-width instead of fixed width where the captured width equals the viewport or parent width.'
  const confidence = collapse?.confidence ?? 0
  if (!collapse || confidence < COLLAPSE_REVIEW) {
    return `## Responsive behavior\n${lead} On screens under 768px, stack side-by-side columns vertically.`
  }
  if (confidence < COLLAPSE_ACT) {
    return `## Responsive behavior\n${lead} Narrow-screen behavior is uncertain. Stack side-by-side columns only when the tree is clearly columns. Do not restack a row of logos, a marquee, or a table.`
  }
  return `## Responsive behavior\n${lead} ${collapseStrategy(collapse.value)}`
}

function collapseStrategy(value: string): string {
  switch (value) {
    case 'horizontal-scroll':
      return 'On screens under 768px, keep the items in a horizontal row that scrolls. Do not stack them.'
    case 'hide-secondary':
      return 'On screens under 768px, hide the secondary column or decorative media and let the primary content fill the width.'
    case 'keep-layout':
      return 'Keep the captured arrangement on small screens. Do not force the items to stack.'
    case 'stack':
      return 'On screens under 768px, stack side-by-side columns vertically.'
    default:
      return 'On screens under 768px, stack side-by-side columns vertically.'
  }
}

const INLINE_SVG_MAX = 40_000 // chars per SVG shown inline
const INLINE_SVG_BUDGET = 250_000 // chars of SVG markup in the whole prompt
const INLINE_DATA_MAX = 2_000 // data: URLs longer than this aren't printed
const INLINE_SHADER_MAX = 24_000 // chars per shader stage shown inline
const INLINE_SHADER_BUDGET = 120_000 // chars of GLSL in the whole prompt
const INLINE_LOTTIE_MAX = 30_000 // Lottie JSON shown inline
const TOO_LARGE = 'too large to paste — match it from the screenshot'

function describeNode(n: CapturedNode): string {
  let head = n.tag
  if (n.id) head += `#${n.id}`
  if (n.classes?.length) head += '.' + n.classes.join('.')
  return head
}

// One more backtick than any run inside `value`, so CSS and attributes stay literal markdown code.
function inlineCode(value: string): string {
  const flat = value.replace(/\s*\n\s*/g, ' ')
  const run = flat.match(/`+/g)?.reduce((max, s) => Math.max(max, s.length), 0) ?? 0
  const fence = '`'.repeat(run + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}

function renderTree(node: CapturedNode, depth: number, lines: string[], isRoot: boolean) {
  const pad = '  '.repeat(depth)
  if (node.tag === '…') {
    lines.push(`${pad}- … ${node.note ?? ''}`.trimEnd())
    return
  }

  let head = inlineCode(describeNode(node))
  if (node.hidden) head += ' — hidden'
  else {
    head += ` — ${node.box.w}×${node.box.h}`
    const pos = node.styles['position']
    if (!isRoot && (pos === 'absolute' || pos === 'fixed' || pos === 'sticky')) head += ` at (${node.box.x}, ${node.box.y})`
  }
  lines.push(`${pad}- ${head}`)

  const inner = '  '.repeat(depth + 1)
  const field = (label: string, value: string) => lines.push(`${inner}- **${label}:** ${value}`)
  const attrs = Object.entries(node.attrs).map(([k, v]) => (v === '' ? k : `${k}="${v}"`))
  if (attrs.length) field('attrs', inlineCode(attrs.join(' ')))
  if (node.text) field('text', inlineCode(JSON.stringify(node.text)))
  const styles = Object.entries(node.styles).map(([k, v]) => `${k}: ${v}`)
  if (styles.length) field('css', inlineCode(styles.join('; ')))
  for (const [name, p] of [['::before', node.before], ['::after', node.after]] as const) {
    if (!p) continue
    const declared = Object.entries(p.styles).map(([k, v]) => `${k}: ${v}`)
    const declaredCode = declared.length ? `; ${inlineCode(declared.join('; '))}` : ''
    lines.push(`${inner}- ${inlineCode(name)} — content ${inlineCode(p.content)}${declaredCode}`)
  }
  for (const s of node.states ?? []) lines.push(`${inner}- ${inlineCode(s.state)} — ${inlineCode(s.declarations)}`)
  for (const rule of node.authored ?? []) field('authored css', inlineCode(rule))
  for (const m of node.motion ?? []) field('motion (JS)', inlineCode(m))
  for (const s of node.scroll ?? []) field('scroll', inlineCode(s))
  if (node.note) field('note', `${node.note}${node.note.startsWith('inline SVG') ? ' (markup under **SVGs**)' : ''}`)

  node.children.forEach((c) => renderTree(c, depth + 1, lines, false))
}

// Probe outlines mix a plain root line with indented "- child" lines. Every line becomes a list item.
function markdownList(lines: string[]): string {
  return lines.map((line) => (line.trimStart().startsWith('-') ? line : `- ${line}`)).join('\n')
}

function kb(chars: number): string {
  return `${Math.max(1, Math.round(chars / 1024))} KB`
}

function countMotion(node: CapturedNode): number {
  return (node.motion ? 1 : 0) + node.children.reduce((n, c) => n + countMotion(c), 0)
}

// Replaces every saved file's original URL with its local path (/capture/…) in a piece of the spec.
function localizer(names: Map<string, string>): (text: string) => string {
  const pairs = Array.from(names, ([url, name]) => [url, `/capture/${name}`] as const)
    .filter(([url]) => /^https?:/.test(url))
    .sort((a, b) => b[0].length - a[0].length)
  return (text) => pairs.reduce((out, [url, local]) => (out.includes(url) ? out.split(url).join(local) : out), text)
}

// The tree with local paths, so each element names the exact file it shows: `src="/capture/image-03.jpg"`
// on the right <img>, `url("/capture/background-02.png")` in the right background. A srcset is dropped
// where the src was saved: only that one file exists locally.
function localizeTree(node: CapturedNode, swap: (text: string) => string): CapturedNode {
  const attrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(node.attrs)) attrs[k] = swap(v)
  if (attrs.src?.startsWith('/capture/')) {
    delete attrs.srcset
    delete attrs.sizes
  }
  const styles = (rec: Record<string, string>) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, swap(v)]))
  return {
    ...node,
    attrs,
    styles: styles(node.styles),
    before: node.before && { ...node.before, styles: styles(node.before.styles) },
    after: node.after && { ...node.after, styles: styles(node.after.styles) },
    states: node.states?.map((st) => ({ ...st, declarations: swap(st.declarations) })),
    children: node.children.map((c) => localizeTree(c, swap)),
  }
}

export function buildPrompt(capture: Capture): string {
  const kit = kitBase(capture)
  const hasScreenshot = !!capture.screenshot

  const svgs = capture.assets.filter((a) => a.kind === 'svg')
  const canvases = capture.assets.filter((a) => a.kind === 'canvas')
  const media = capture.assets.filter((a) => a.kind !== 'svg' && a.kind !== 'canvas')
  const plan = planMedia(media, capture)
  const swap = localizer(plan.names)
  const root = localizeTree(capture.root, swap)

  const lines: string[] = []
  renderTree(root, 0, lines, true)
  const tree = lines.join('\n')

  // Files saved into public/capture/ are referred to by their local path, the original kept for context.
  const ref = (url: string) => {
    const local = plan.names.get(url)
    if (local) return `\`/capture/${local}\` (from <${url}>)`
    if (url.startsWith('data:') && url.length > INLINE_DATA_MAX) return `(inline data, ${kb(url.length)}; ${TOO_LARGE})`
    return `<${url}>`
  }

  const sections: string[] = []

  sections.push(`# Task: Recreate this UI section 1:1

You are rebuilding a UI section captured from a live website as its own **Next.js app** named \`${projectName(capture)}\` (see **Step 1** and **Stack & output**).

The goal is a **pixel-accurate 1:1 clone**: the same structure, layout, dimensions, spacing, typography, colors, backgrounds, borders, radii, shadows, imagery, SVGs, animations, and interaction states. Do not redesign, "improve", or modernize anything. When this spec and your instincts disagree, follow the spec.

**Work autonomously.** Do not ask the user any questions, offer options, or wait for confirmation: everything you need is in this spec and the attached screenshot. Where something is ambiguous, make the most faithful choice from the screenshot and keep going. List any assumptions in your final summary.

**Only touch this app.** ${capture.project ? `Work in the \`${capture.project.name}/\` folder (see **Step 1**) and run every command from it.` : `Create \`${projectName(capture)}/\`, then run every command from that folder.`} Never change or build on any other project.`)

  sections.push(`## Source
- Page: ${capture.url}${capture.title ? ` ("${capture.title}")` : ''}
- Captured element: \`${capture.selector}\` (\`<${root.tag}>\`)
- Rendered size: **${root.box.w}×${root.box.h}px**, at a viewport of ${capture.viewport.w}×${capture.viewport.h}px (devicePixelRatio ${capture.viewport.dpr})
- Screenshot: ${hasScreenshot ? `one, attached to this message${capture.project && capture.saved?.screenshot ? ` and saved as \`public/reference/${capture.saved.screenshot}\`` : ''}` : 'any image attached to this message'}. It is the section's initial look${capture.fullScreenshot ? ', the whole section top to bottom' : ''}: build to match it, and use it as the visual source of truth for anything this text spec does not cover. Scroll, hover and click states have no screenshots: build them from **Scroll story** and **Interactions**. The screenshot is reference only: do not render it in the section.`)

  if (capture.analysis) sections.push(capture.analysis.promptSection)

  sections.push(installSection(capture, kit, plan))

  sections.push(stackSection(kit, capture.analysis?.scope))

  sections.push(fontsSection(capture, ref))

  sections.push(`## Structure & exact styles
The captured tree is a nested markdown list. How to read each item:

- An element line is \`tag#id.class — width×height\`. Sizes are the rendered pixel sizes at the capture viewport.
- \`at (x, y)\` is the offset from the section's top-left corner. It appears only on absolute, fixed, or sticky elements.
- \`— hidden\` means the element was \`display: none\` when captured (inactive tabs, closed menus, collapsed panels). Build it, hidden, with the same styles. It has no measured size.
- Nested bullets under an element are its fields, then its child elements.
- **attrs** holds the relevant HTML attributes. **text** is the element's own text; inline tags inside it are kept.
- **css** lists computed values that differ from browser defaults. Inherited properties (color, font-*, line-height, letter-spacing, …) appear only where they change from the parent.
- \`::before\` and \`::after\` are pseudo-elements with their full styles. They are often the decorative layer (glows, gradients, masks).
- \`:hover\`, \`:focus\`, and similar lines are state rules taken from the site's stylesheets.
- **authored css** is the site's original rule for an animated element, with the \`var(--…)\` references that computed values resolve away.
- **motion (JS)** means the value kept changing while the page sat idle, so a script animates it (see **Animation & motion**).
- **scroll** lists values that changed while the section was scrolled through the viewport, as \`progress% value\` points; between two points with the same value it holds (see **Scroll story**).
- Class names are the original site's. Treat them as hints about intent; do not reuse them verbatim.

${tree}`)

  if (capture.responsive.length) {
    sections.push(`## Responsive behavior (media/container queries from the site's CSS that target this section)
Recreate the same breakpoints and changes:
\`\`\`css
${capture.responsive.map((r) => `${r.media} {\n  ${r.selector} { ${r.declarations} }\n}`).join('\n')}
\`\`\``)
  } else {
    sections.push(responsiveFallback(capture.analysis?.collapse))
  }

  const simulation = simulationSection(capture)
  if (simulation) sections.push(swap(simulation))
  const texts = textSection(capture)
  if (texts) sections.push(texts)
  const motion = animationSection(capture, countMotion(root))
  if (motion) sections.push(motion)
  const gsap = gsapSection(capture)
  if (gsap) sections.push(gsap)
  const scroll = scrollSection(capture)
  if (scroll) sections.push(swap(scroll))
  const interactions = interactionsSection(capture)
  if (interactions) sections.push(swap(interactions))
  const lottie = lottieSection(capture, plan)
  if (lottie) sections.push(lottie)
  const webgl = webglSection(capture, ref)
  if (webgl) sections.push(webgl)

  if (capture.embeds.length) {
    sections.push(`## Canvas, WebGL & embeds
These can't be captured as DOM. Rebuild each one as described. Where the original can't be reused, match the captured frame as closely as possible and keep the same size and position.
${capture.embeds
  .map((e) => {
    const snapshot = canvases.find((c) => c.target === e.target)
    const rt = capture.runtime
    const glRead = rt && [...rt.three, ...rt.webgl].some((g) => g.target === e.target)
    const readLottie = rt?.lottie.length && /Lottie/.test(e.kind)
    const code = (capture.code ?? []).some((c) => c.reasons.some((r) => r.includes(`\`${e.target}\``)) || c.shaders.length)
    const detail = glRead
      ? 'Its scene, shaders and settings were read from the running page: see **WebGL & 3D**.'
      : readLottie
        ? 'Its animation data was read from lottie-web: see **Lottie animations**. The SVG markup is one frozen frame; play the animation instead.'
        : e.offscreen
          ? `Drawn with WebGL inside a Web Worker (the page calls transferControlToOffscreen), so its draw calls could not be watched.${code ? ' Its original code was found in the page\'s scripts: see **Canvas source code**, and port it (same shaders, same uniforms and animation).' : ''}`
          : `${e.detail}${code ? ' Its original code was found in the page\'s scripts: see **Canvas source code**.' : ''}`
    const local = snapshot?.file && plan.archived.has(snapshot.file)
    const still = local
      ? `\n  Snapshot of its pixels at capture time: \`/capture/${snapshot.file}\`. Compare your rebuild against it. If the drawing can't be recreated faithfully (or it never changes), render this image at the same size and position instead; never leave the area empty or fill it with a placeholder.`
      : snapshot
        ? '\n  Snapshot of this frame: visible in the screenshot'
        : ''
    return `- **${e.kind}** on \`${e.target}\` [${e.box.w}×${e.box.h}]${e.src ? `: ${/^https?:/.test(e.src) ? ref(e.src) : e.src}` : ''}\n  ${detail}${still}`
  })
  .join('\n')}`)
  }

  const code = codeSection(capture)
  if (code) sections.push(code)

  if (media.length || plan.names.size) sections.push(mediaSection(media, plan))

  if (svgs.length) sections.push(svgSection(svgs))

  if (capture.pageMedia.length) {
    sections.push(`## Files loaded by the page's scripts
The page's scripts loaded these (3D models, Lottie/Rive animations, shaders, fonts). They may belong to this section's canvas, embeds, or animations:
${capture.pageMedia.map((u) => `- ${ref(u)}`).join('\n')}`)
  }

  const caveats: string[] = []
  if (capture.truncated) caveats.push(`The capture hit its node budget (${capture.nodeCount} elements), so some deep children were omitted. Infer them from the screenshot and the sibling patterns.`)
  if (capture.unreadableStylesheets) caveats.push(`${capture.unreadableStylesheets} stylesheet(s) could not be read (cross-origin without CORS), so some hover, responsive, and font rules may be missing.`)
  if (capture.root.box.h > capture.viewport.h && hasScreenshot && !capture.fullScreenshot) caveats.push('The section is taller than the viewport, so the initial-look screenshot shows only the visible part.')
  if (capture.hiddenNodes) caveats.push(`${capture.hiddenNodes} hidden elements (tabs, menus, collapsed panels) are marked **hidden** in the tree; they have no measured size.`)
  const readGl = new Set([...(capture.runtime?.three ?? []), ...(capture.runtime?.webgl ?? [])].map((g) => g.target))
  const unreadGl = capture.embeds.filter((e) => /WebGL|Canvas/.test(e.kind) && !readGl.has(e.target))
  if (unreadGl.length) caveats.push(capture.code?.length ? "Some canvas/WebGL content couldn't be watched while it ran; its code comes from the page's scripts (**Canvas source code**), so values set at runtime (colors passed in, sizes, uniforms) must be read from that code." : 'Some canvas/WebGL content is captured as pixels only; its drawing code and scene could not be read.')
  if (readGl.size) caveats.push('WebGL data comes from the running page: values driven by the mouse or scroll are as they were at capture time.')
  if (capture.simulation && !capture.simulation.idle) caveats.push('Scripted changes during the idle watch are listed under Recorded simulation. Replay that timeline; the tree alone is the first frame.')
  if (capture.scrollRecorded) caveats.push('Scroll-linked changes were recorded by scrolling down only, after the section sat still. Whether a reveal reverses when scrolling back up was not tested: keep it played.')
  if (capture.interactions) caveats.push("Hovers and clicks were played with synthetic events. During hovers the site's CSS :hover rules were applied too, so pure-CSS hovers on buttons, links and cards appear under **Interactions** as well as in the tree's state lines. Drag, swipe, long-press and keyboard-only interactions were not played.")
  else caveats.push('Hover-only and click-only motion was not played.')
  const saved = capture.saved
  if (saved?.failed.length) caveats.push(`${saved.failed.length} file(s) could not be fetched while capturing, so they aren't in \`public/capture/\`. For each one, crop that area out of the screenshot and use it at the same size (not a gray box or stock image), and tell the user which file is missing: ${saved.failed.slice(0, 5).map((f) => `${f.src.startsWith('data:') ? 'inline data' : f.src.slice(0, 120)} (${f.reason})`).join('; ')}`)
  sections.push(`## Capture caveats\n${caveats.map((c) => `- ${c}`).join('\n')}`)

  sections.push(`## Acceptance checklist
- [ ] At a ${capture.viewport.w}px-wide viewport, the section renders at ${root.box.w}×${root.box.h}px (±2px).
- [ ] Fonts load from the listed sources, and every family, weight, size, line-height, letter-spacing, OpenType feature and variable-font axis matches the **css** lines.
- [ ] Every color, gradient, background layer, blend mode, filter and mask matches exactly; no approximated palette colors.
- [ ] Padding, margins, gaps, radii, borders, and shadows match the **css** lines.
- [ ] Pseudo-elements (::before / ::after) are recreated with their full styles.
- [ ] Hover, focus, and active states behave as specified, including transitions and their durations.
- [ ] CSS keyframes, script animations and JS-driven motion run with the same timing and easing, and respect prefers-reduced-motion.
- [ ] Every image and video is the real file in \`public/capture/\` (nothing hotlinked, no placeholders or stock images), referenced by local path, at the listed sizes. SVGs and canvas/WebGL areas match the spec.
- [ ] Hidden content (tabs, menus, panels) exists and can be revealed the same way.
- [ ] Breakpoints listed above are implemented.
- [ ] Semantic HTML and all alt / aria attributes are preserved.
- [ ] It's a standalone Next.js app in \`${projectName(capture)}/\`: \`npm run build\` passes with no type errors, and \`npm run dev\` shows the section on the home page.${
    capture.runtime?.gsap?.tweens.length
      ? '\n- [ ] GSAP timelines and tweens play in the same order with the same values, durations and eases; ScrollTriggers start and end at the same points.'
      : ''
  }${capture.scrollRecorded ? "\n- [ ] Scroll-linked values match the **scroll** lines at each progress point, pinned stretches last the same scroll distance, and every phase of the **Scroll story** happens in the same order and at the same progress." : ''}${capture.simulation?.texts.length ? '\n- [ ] Every entry under **Text animations** plays the same way: same kind, speed, stagger and values.' : ''}${
    capture.interactions?.items.length
      ? '\n- [ ] Every hover and click under **Interactions** produces the same changes, revealed content and motion (durations and easings), and undoes cleanly; it matches its frame.'
      : ''
  }${
    readGl.size ? '\n- [ ] Each WebGL canvas renders the same scene and shaders, with the same camera, colors, and animation speed.' : ''
  }`)

  return sections.join('\n\n')
}

// ---------- runtime sections (from the page probe) ----------

function shaderBlock(s: ShaderSource, budget: { left: number }): string {
  const out = [`- **${s.name}**`]
  if (s.uniforms?.length) out.push(`  Uniforms (values at capture time):\n${s.uniforms.map((u) => `  - ${u}`).join('\n')}`)
  for (const stage of ['vertex', 'fragment'] as const) {
    const code = s[stage]
    if (!code) continue
    if (code.length <= INLINE_SHADER_MAX && code.length <= budget.left) {
      budget.left -= code.length
      out.push(`  ${stage} shader:\n\`\`\`glsl\n${code}\n\`\`\``)
    } else {
      out.push(`  ${stage} shader: ${kb(code.length)}, ${TOO_LARGE}.`)
    }
  }
  return out.join('\n')
}

function webglSection(capture: Capture, ref: (url: string) => string): string | null {
  const rt = capture.runtime
  if (!rt) return null
  const budget = { left: INLINE_SHADER_BUDGET }
  const texture = (t: string) => `- ${/^(https?|data):/.test(t) ? ref(t) : t}`
  const parts: string[] = []

  rt.three.forEach((t) => {
    const lines = [
      `### three.js scene on \`${t.target}\`${t.revision ? ` (three.js ${t.revision})` : ''}`,
      'Rebuild it with three.js (the `three` package), in a canvas with the same size and position as in the tree.',
    ]
    if (t.sceneJson) {
      lines.push(`An exact scene export (Object3D.toJSON, loadable with THREE.ObjectLoader) was captured; ${TOO_LARGE}. Rebuild the scene from the description below.`)
    } else if (t.sceneJsonError) {
      lines.push(`No scene export: ${t.sceneJsonError}. Rebuild the scene from the description below.`)
    }
    lines.push(`**Renderer**:\n${t.renderer.map((l) => `- ${l}`).join('\n')}`)
    if (t.camera) lines.push(`**Camera**: ${t.camera}`)
    if (t.scene.length) {
      lines.push(`**Scene graph** (\`animating:\` values changed while the page sat idle, per second):\n\n${markdownList(t.scene)}`)
    } else {
      lines.push('The renderer had not drawn a scene yet when the section was captured.')
    }
    if (t.materials.length) lines.push(`**Materials**:\n${t.materials.map((m) => `- ${m}`).join('\n')}`)
    if (t.shaders.length) {
      const blocks = t.shaders.map((s) => shaderBlock(s, budget))
      lines.push(`**Shaders**:\n${blocks.join('\n')}`)
    }
    if (t.postprocessing.length) {
      const blocks = t.postprocessing.map((s) => shaderBlock(s, budget))
      lines.push(`**Post-processing** (full-screen passes drawn after the scene, in this order; use EffectComposer with ShaderPass):\n${blocks.join('\n')}`)
    }
    if (t.textures.length) lines.push(`**Textures**:\n${t.textures.map(texture).join('\n')}`)
    parts.push(lines.join('\n\n'))
  })

  rt.webgl.forEach((g) => {
    const lines = [`### Hand-written WebGL on \`${g.target}\``, `Context: ${g.context}.`]
    if (g.programs.length) {
      lines.push(
        'Recreate it with the same shaders and uniform values: a minimal WebGL setup, or a full-screen plane with a three.js RawShaderMaterial (OGL works too). Uniforms marked as animating change every frame: drive them from requestAnimationFrame at the same rate. Uniforms fed by the mouse or scroll only change when the user interacts.',
      )
      const blocks = g.programs.map((p) => shaderBlock(p, budget))
      lines.push(blocks.join('\n'))
    } else {
      lines.push(
        rt.lateProbe
          ? "Its shaders weren't recorded because the page loaded before JevElements was active. Reload the page and capture again to get them."
          : 'No shader programs were recorded for it; it may render from a worker (OffscreenCanvas).',
      )
    }
    if (g.textures.length) lines.push(`Textures:\n${g.textures.map(texture).join('\n')}`)
    parts.push(lines.join('\n\n'))
  })

  const hasThree = rt.libraries.some((l) => l.name === 'three.js')
  if (rt.lateProbe && hasThree && !rt.three.length && capture.embeds.some((e) => /WebGL|Canvas/.test(e.kind))) {
    parts.push(
      'three.js is on the page, but it started before JevElements was active, so its 3D scene could not be read. Reload the page and capture again to get the scene graph, materials, shaders and an exact scene export.',
    )
  }
  return parts.length ? `## WebGL & 3D (read from the running page)\n${parts.join('\n\n')}` : null
}

function gsapSection(capture: Capture): string | null {
  const g = capture.runtime?.gsap
  if (!g) return null
  if (g.bundled) {
    return `## GSAP
GSAP animates elements in this section, but the site bundles it without a global, so its timelines couldn't be read. Use GSAP for the clone and take the motion from the **motion (JS)** and **scroll** lines in the tree.`
  }
  if (!g.tweens.length && !g.scrollTriggers.length) return null

  type Item = { id: number; code: string; start: number; duration?: number }
  const children = (parent: number | undefined): Item[] =>
    [...g.timelines.filter((t) => t.timeline === parent), ...g.tweens.filter((t) => t.timeline === parent)].sort((a, b) => a.start - b.start)
  const render = (parent: number | undefined, depth: number): string[] =>
    children(parent).flatMap((item) => {
      const at = parent === undefined ? '' : `at ${item.start}s: `
      const line = `${'  '.repeat(depth)}- ${at}#${item.id} \`${item.code}\`${item.duration !== undefined ? ` · total ${item.duration}s` : ''}`
      return item.duration !== undefined ? [line, ...render(item.id, depth + 1)] : [line]
    })

  const lines = [
    '## GSAP animations (read from the page\'s live timelines)',
    `GSAP${g.version ? ` ${g.version}` : ''}. Recreate these with GSAP (the \`gsap\` package${g.scrollTriggers.length ? ', with ScrollTrigger registered' : ''}), keeping the same values, durations, eases, delays, staggers and order. Target strings are element labels from the tree, not selectors: point them at the matching elements (refs in React). \`/* function */\` values ran custom code that can't be read; infer it from what they animate.`,
  ]
  const tree = render(undefined, 0)
  if (tree.length) lines.push(tree.join('\n'))
  if (g.scrollTriggers.length) {
    lines.push(
      `ScrollTriggers (the section's top is at page y = ${capture.root.box.y}px, at a ${capture.viewport.w}×${capture.viewport.h} viewport):\n${g.scrollTriggers
        .map((st) => `- trigger \`${st.trigger}\` \`${st.config}\` · ${st.range}${st.animation ? ` · drives #${st.animation}` : ''}`)
        .join('\n')}`,
    )
  }
  return lines.join('\n\n')
}

function scrollSection(capture: Capture): string | null {
  const smooth = capture.runtime?.smoothScroll
  const story = capture.scrollStory
  if (!capture.scrollRecorded && !smooth) return null
  const lines = ['## Scroll story (scroll-linked motion)']
  if (capture.scrollRecorded && story) {
    const gsap = capture.runtime?.gsap
    const how = gsap?.scrollTriggers.length
      ? 'the ScrollTriggers under **GSAP animations** drive them; keep their start/end, scrub and pin settings'
      : gsap
        ? 'use GSAP ScrollTrigger (`scrub` for values that follow the scroll, `pin` for pinned stretches)'
        : capture.libraries.some((l) => /Motion|Framer/i.test(l.name))
          ? "use Motion (Framer Motion): `useScroll({ target, offset })` + `useTransform` for values that follow the scroll, `whileInView` for one-time reveals"
          : "use GSAP ScrollTrigger (the `gsap` package) or Motion's `useScroll` (the `motion` package), or CSS scroll-driven animations (`animation-timeline: view()`)"
    const range = story.end - story.start
    lines.push(
      `The page was scrolled through the section in ${story.samples} steps, from page scroll ${story.start}px (0%) to ${story.end}px (100%), ${Math.round((range / story.viewport.h) * 10) / 10} viewport heights at a ${story.viewport.w}×${story.viewport.h} viewport. 0% is the section (or its pin spacer / sticky track) entering at the bottom of the viewport; 100% is it leaving at the top. To convert: scroll px = ${story.start} + progress% × ${range / 100}.`,
      `Recreate it tied to scroll: ${how}. Values that change in one short stretch and then hold are reveals (play once on enter); values that change across a long stretch follow the scroll (scrub). Each element's exact values per progress point are on its **scroll** lines in the tree.`,
    )
    if (story.pinned.length) {
      lines.push(
        `**Pinned** (stays fixed in the viewport while the page scrolls underneath):\n${story.pinned
          .map((p) => `- \`${p.target}\` from ${p.from}% to ${p.to}% (page scroll ${pageY(story, p.from)}px → ${pageY(story, p.to)}px, ${Math.round(((pageY(story, p.to) - pageY(story, p.from)) / story.viewport.h) * 10) / 10} viewport heights)`)
          .join('\n')}\nBuild the pin the way the site does: a GSAP ScrollTrigger \`pin\` with the same scroll length, or \`position: sticky; top: 0\` inside a track tall enough for the same distance.`,
      )
    }
    if (story.continuous.length) {
      lines.push(`**Changes continuously with the scroll** (parallax, scrubbed progress):\n${story.continuous.map((c) => `- ${c}`).join('\n')}`)
    }
    const changing = story.phases.filter((p) => p.kind === 'change')
    if (changing.length) {
      const phaseLines = story.phases.map((p, i) => {
        const head = `${i + 1}. **${p.from}% → ${p.to}%** (scroll ${p.scrollFrom}px → ${p.scrollTo}px): ${p.kind === 'hold' ? (p.changes.length ? 'hold (nothing switches; only scrubbed values move)' : 'hold, nothing changes') : 'changes'}`
        return [head, ...p.changes.map((c) => `   - ${c}`)].join('\n')
      })
      lines.push(`**Phases** (the story in order):\n${phaseLines.join('\n')}`)
    }
    if (story.events.length) {
      lines.push(
        `**DOM changes while scrolling** (class toggles, nodes added or removed, state attributes), at the progress they happened:\n${story.events.map((e) => `- ${e.t}% \`${e.target}\`: ${e.change}`).join('\n')}`,
      )
    }
  } else if (capture.scrollRecorded) {
    lines.push("The values on the tree's **scroll** lines changed while the section was scrolled through the viewport. Recreate them tied to scroll.")
  }
  if (smooth) {
    lines.push(
      smooth.startsWith('Lenis')
        ? `Smooth scrolling: ${smooth}. Add the same smooth scrolling with the \`lenis\` package and these options.`
        : `Smooth scrolling: ${smooth}. Add equivalent smooth scrolling (the \`lenis\` package is the usual choice).`,
    )
  }
  return lines.join('\n\n')
}

function interactionsSection(capture: Capture): string | null {
  const report = capture.interactions
  if (!report || (!report.tested.hover && !report.tested.click)) return null
  const lines = [
    '## Interactions (hover & click, played on the live page)',
    `JevElements hovered ${report.tested.hover} and clicked ${report.tested.click} element(s) in the section with real pointer-event sequences (pointerover/enter, move, down, up, click) and recorded what changed. Each hover also applied the site's CSS \`:hover\` rules, so buttons, links and cards with pure-CSS hovers are listed here with their transitions. \`:focus\` effects are only the state lines in the tree (\`:focus — …\`). Implement both.`,
  ]
  const render = (i: Interaction) => {
    const head = `- **${i.kind}** \`${i.target}\`${i.text ? ` "${i.text}"` : ''}${i.similar ? ` (and ${i.similar} more that look the same: give them the same behaviour)` : ''} · ${i.signal}${i.restored ? '' : ' · did not fully undo (later entries started from the changed state)'}`
    const block = [head]
    if (i.changes.length) block.push(`  - Changes:\n${i.changes.map((c) => `    - ${c}`).join('\n')}`)
    if (i.appeared.length) block.push(`  - Appeared (build it, hidden until this ${i.kind}):\n${i.appeared.map((c) => `    - ${c}`).join('\n')}`)
    if (i.disappeared.length) block.push(`  - Disappeared:\n${i.disappeared.map((c) => `    - ${c}`).join('\n')}`)
    if (i.animations.length) block.push(`  - Motion (use these durations and easings):\n${i.animations.map((c) => `    - ${c}`).join('\n')}`)
    return block.join('\n')
  }
  const hovers = report.items.filter((i) => i.kind === 'hover')
  const clicks = report.items.filter((i) => i.kind === 'click')
  if (hovers.length) lines.push(`### Hover\nHover effects on buttons, cards and links (CSS \`:hover\` and script-driven). Build CSS ones with Tailwind \`hover:\` / \`group-hover:\` and the listed transition; revert them on pointer leave, with the same motion.\n${hovers.map(render).join('\n')}`)
  if (clicks.length) {
    lines.push(
      `### Click\nWire each one up as a real control: buttons with \`aria-expanded\`/\`aria-controls\` for disclosures, \`role="tablist"/"tab"/"tabpanel"\` for tabs, focus handling and Escape-to-close for menus and dialogs. Content that appears is part of the section: build it from these outlines.\n${clicks.map(render).join('\n')}`,
    )
  }
  if (!report.items.length) lines.push('None of them changed anything visible: any remaining hover and focus effects come from the CSS state lines in the tree.')
  if (report.skipped.length) lines.push(`Not clicked on purpose: ${report.skipped.join('; ')}. Build them as ordinary controls with the captured styles.`)
  return lines.join('\n\n')
}

function pageY(story: NonNullable<Capture['scrollStory']>, progress: number): number {
  return Math.round(story.start + ((story.end - story.start) * progress) / 100)
}

function lottieSection(capture: Capture, plan: MediaPlan): string | null {
  const items = capture.runtime?.lottie ?? []
  if (!items.length) return null
  const lines = items.map((l) => {
    let source: string
    const local = l.url && plan.names.get(l.url)
    if (local) source = `\`public/capture/${local}\` (original <${l.url}>); load it from \`/capture/${local}\``
    else if (l.url) source = `<${l.url}>`
    else if (l.json && l.json.length <= INLINE_LOTTIE_MAX) source = `\n\`\`\`json\n${l.json}\n\`\`\``
    else if (l.json) source = `inline data (${kb(l.json.length)}); ${TOO_LARGE}`
    else source = 'not readable'
    return `- on \`${l.target}\`: ${l.settings}. Animation data: ${source}`
  })
  return `## Lottie animations (read from lottie-web)
Play the same animation data with lottie-web or @lottiefiles/dotlottie-web, in a container of the same size and with the same settings:
${lines.join('\n')}`
}

function fontsSection(capture: Capture, ref: (url: string) => string): string {
  const lines = capture.fonts.map((f) => {
    const out = [`- **${f.family}**: weights ${f.weights.join(', ')}${f.styles.some((s) => s !== 'normal') ? `; styles ${f.styles.join(', ')}` : ''}`]
    for (const link of f.links) out.push(`  - Stylesheet: ${ref(link)}`)
    if (f.faces.length) {
      let faces = f.faces.join('\n')
      for (const file of f.files) faces = faces.split(file).join(ref(file).replace(/^[<`]|[>`]$/g, ''))
      out.push(`  - @font-face rules from the site (files: ${f.files.map(ref).join(', ')}):\n\`\`\`css\n${faces}\n\`\`\``)
    }
    if (!f.links.length && !f.faces.length) out.push('  - No @font-face rule or font stylesheet found: a system font, or loaded by a script (check "Files loaded by the page\'s scripts").')
    return out.join('\n')
  })
  return `## Fonts
Load these fonts exactly as the site does. The per-element typography (size, weight, line-height, letter-spacing, OpenType features, variable-font axes, text-wrap) is in the tree's **css** lines.
${lines.join('\n') || '- (no text found)'}`
}

function animationSection(capture: Capture, jsMotion: number): string | null {
  const parts: string[] = []
  if (capture.libraries.length) {
    parts.push(`Libraries detected on the page: ${capture.libraries.map((l) => `**${l.name}**${l.version ? ` ${l.version}` : ''}`).join(', ')}. When recreating script-driven motion, use the same library (install it with npm).`)
  }
  if (capture.keyframes.length) {
    parts.push(`### CSS keyframes (and the @property rules they animate)
Elements reference these by name in their \`animation\` values.
\`\`\`css
${capture.keyframes.join('\n\n')}
\`\`\``)
  }
  if (capture.animations.length) {
    parts.push(`### Script animations (Web Animations API)
Created by JavaScript (e.g. Motion / Framer Motion). Reproduce them with the same keyframes and timing:
${capture.animations.map((a) => `- \`${a.target}\`${a.scrollDriven ? ' (scroll-driven)' : ''}: ${a.timing}\n${a.keyframes.map((k) => `  - ${k}`).join('\n')}`).join('\n')}`)
  }
  if (jsMotion) {
    const lib = capture.libraries.find((l) => /GSAP|Motion|anime|Velocity|Webflow/i.test(l.name))
    parts.push(`### JavaScript-driven motion
${jsMotion} element(s) kept changing while the page sat idle (marked **motion (JS)** in the tree, with the sampled values). A script animates them every frame${lib ? `, most likely ${lib.name}` : ''}. Recreate the same continuous motion: direction, range and speed should match the sampled values, which span about four seconds.`)
  }
  return parts.length ? `## Animation & motion\n${parts.join('\n\n')}` : null
}

function simulationSection(capture: Capture): string | null {
  const sim = capture.simulation
  if (!sim?.events.length) return null
  const seconds = Math.round(sim.durationMs / 100) / 10
  const lines = [
    '## Recorded simulation',
    `The section was watched for ${seconds}s while the page sat idle. A script changed it over that time (a mock UI swapping copy, a class toggle, nodes appearing, or inline styles from GSAP, Motion, or a custom loop).`,
    'Replay these changes on a loop with the same timing. Use GSAP, Motion, or CSS when that library is named below; otherwise drive them with component state. The tree is the first frame.',
    sim.events.map((e) => `- ${e.t.toFixed(1)}s \`${e.target}\`: ${e.change}`).join('\n'),
  ]
  return lines.join('\n\n')
}

const TEXT_HOW: Record<TextAnimation['kind'], string> = {
  typing: 'type it out character by character with a timer at that speed (keep the caret if one is shown)',
  deleting: 'delete it character by character at that speed',
  stream: 'append it in chunks at that pace, the way a chat reply streams in',
  counter: 'animate the number between the values (requestAnimationFrame or Motion\'s animate) and format it the same way on every frame',
  scramble: 'scramble random characters that settle into the final text over the same time',
  cycle: 'cycle through the texts in order on a loop, with the same interval and transition',
  split: 'split the text into the same spans (one per word or letter) and reveal them with the same stagger, duration and easing',
  changes: 'replay the values in order with the same timing',
}

function textSection(capture: Capture): string | null {
  const texts = capture.simulation?.texts ?? []
  if (!texts.length) return null
  const items = texts.map((t) => {
    const values = t.values.length > 1 ? `\n  - values in order: ${t.values.map((v) => (v === '…' ? '…' : JSON.stringify(v))).join(' → ')}` : `\n  - text: ${JSON.stringify(t.values[0] ?? '')}`
    return `- \`${t.target}\` **${t.kind}**: ${t.summary} · ${t.timing}. Rebuild: ${TEXT_HOW[t.kind]}.${values}`
  })
  return `## Text animations
Text that a script wrote while the page sat idle, recorded change by change (typing, streaming replies, counters, scrambles, rotating words), and split-text reveals. The tree shows each element's first value; animate it to match. Respect prefers-reduced-motion by showing the final text.
${items.join('\n')}`
}

const CODE_SHADER_BUDGET = 60_000 // chars of GLSL from the page's scripts in the whole prompt

function codeSection(capture: Capture): string | null {
  const refs: CodeRef[] = capture.code ?? []
  if (!refs.length) return null
  let budget = CODE_SHADER_BUDGET
  const parts = refs.map((c) => {
    const where = c.file ? `\`public/reference/code/${c.file}\` (from <${c.url}>, ${kb(c.size)})` : `<${c.url}> (${kb(c.size)})`
    const out = [`### ${where}`, `Why: ${c.reasons.join('; ')}.`]
    if (c.excerpt) out.push(`The code around that match (minified; the component that creates the canvas and what it passes in, such as colors, seeds and sizes):\n\`\`\`js\n${c.excerpt}\n\`\`\``)
    if (c.shaders.length) {
      const shown: string[] = []
      for (const sh of c.shaders) {
        if (sh.length > budget) {
          shown.push(`// … ${kb(sh.length)} more GLSL: read it in the file`)
          continue
        }
        budget -= sh.length
        shown.push(sh)
      }
      out.push(`GLSL found in this script, in source order. These are pieces the code joins into the vertex and fragment shaders (headers with uniforms, shared functions, main()); read the file around them to see how they are combined and which uniforms are set each frame:\n${shown.map((sh) => `\`\`\`glsl\n${sh}\n\`\`\``).join('\n')}`)
    }
    return out.join('\n\n')
  })
  return `## Canvas source code (from the page's scripts)
Some canvases draw with code the capture couldn't watch run (a Web Worker, or WebGL set up before JevElements loaded). Their original code ships in the page's scripts, found below${refs.some((c) => c.file) ? ' and saved in `public/reference/code/` so you can read the whole file' : ''}. Port it into the rebuild (a client component with a \`<canvas>\` of the same size and a WebGL context, in a Web Worker or not): keep the GLSL exactly as written, set the same uniforms, and drive time the same way. Rename minified identifiers to readable names. Compare against the canvas snapshot under **Canvas, WebGL & embeds**.

${parts.join('\n\n')}`
}

// The files in the zip, by source URL. Only files the extension saved and uploaded get a local name;
// anything else keeps its original URL in the spec.
interface MediaPlan {
  names: Map<string, string> // source URL → file name in public/capture/
  archived: Set<string> // names in the zip
}

function planMedia(media: Asset[], capture: Capture): MediaPlan {
  const saved = capture.saved
  const archived = new Set(capture.project && saved?.archive ? saved.uploaded.filter((p) => p.startsWith('capture/')).map((p) => p.slice('capture/'.length)) : [])
  const names = new Map<string, string>()
  for (const a of media) if (a.file && archived.has(a.file)) names.set(a.src, a.file)
  for (const [src, name] of Object.entries(saved?.files ?? {})) if (archived.has(name)) names.set(src, name)
  return { names, archived }
}

// Step 1 of the rebuild. With the backend running, the extension downloaded <name>.zip: the whole
// Next.js app with every saved file in public/ (backend/src/lib/archive.ts), so the agent only installs.
function installSection(capture: Capture, kit: string, plan: MediaPlan): string {
  const dir = projectName(capture)
  const { file, component } = componentNames(kit)
  const saved = capture.saved
  if (!capture.project) {
    return [
      '## Step 1: set up the Next.js app',
      `JevElements couldn't package this capture as an app zip (its backend wasn't running), so the page's files weren't saved: **Images & video** lists them with their original URLs. Create the app, then replace \`app/page.tsx\` so it renders \`${component}\` from \`components/${file}.tsx\`.`,
      `\`\`\`bash\nnpx create-next-app@latest ${dir} --yes --ts --tailwind --app --no-src-dir --use-npm\ncd ${dir}\n\`\`\``,
      'The screenshot is the visual source of truth. Do not render it in the section.',
    ].join('\n\n')
  }

  const shot = saved?.screenshot && saved.uploaded.includes(`reference/${saved.screenshot}`) ? saved.screenshot : undefined
  const codeFiles = (capture.code ?? []).filter((c) => c.file).length
  const what = [
    `\`components/${file}.tsx\`: the placeholder \`${component}\` to replace with the section; \`app/page.tsx\` already renders it`,
    '`app/globals.css` (Tailwind CSS v4), `app/layout.tsx`, `package.json`, `tsconfig.json` (`@/*` alias)',
    plan.archived.size ? `\`public/capture/\`: the ${plan.archived.size} file${plan.archived.size === 1 ? '' : 's'} the section shows (images, video, canvas snapshots, textures, models), downloaded from the live page` : '',
    shot ? `\`public/reference/${shot}\`: the screenshot attached to this message` : '',
    codeFiles ? `\`public/reference/code/\`: ${codeFiles} script${codeFiles === 1 ? '' : 's'} from the page with the canvas drawing code (see **Canvas source code**)` : '',
    '`PROMPT.md`: this prompt',
  ].filter(Boolean)
  return [
    '## Step 1: you are in the app',
    `The current folder is \`${capture.project.name}/\`, extracted from \`${capture.project.name}.zip\`: a Next.js App Router + TypeScript + Tailwind CSS v4 app that is already set up, with the page's files in \`public/\`. Do not run create-next-app, download anything, or extract anything. If the current folder isn't \`${capture.project.name}\`, \`cd\` into it first.`,
    `It contains:\n${what.map((w) => `- ${w}`).join('\n')}`,
    'Install the dependencies once, then build the section:',
    '```bash\nnpm install\n```',
    'The files in `public/` are the exact files from the page. Use them as they are, by their local paths (`/capture/…`). Do not hotlink the original site or swap in placeholder images, stock photos, solid colors or gradients.',
    'The screenshot is the visual source of truth. Do not render it in the section.',
  ].join('\n\n')
}

function mediaSection(media: Asset[], plan: MediaPlan): string {
  const later = media.some((a) => a.when && !a.sequence)
    ? '\n\nFiles marked **shown …** are not on screen in the first frame: the scroll story or a hover/click swaps them in (another `src` on the same element, a new background image, or new elements rendered for one step). Include every one of them, preload them, and switch at the same point.'
    : ''
  const list = media
    .filter((a) => !a.sequence)
    .map((a) => mediaLine(a, plan.names.get(a.src)))
    .join('\n')
  return `## Images & video${later}
The files are in \`public/capture/\` (Step 1). The tree above already names each one on the element that shows it (\`src="/capture/…"\`, \`poster\`, \`url("/capture/…")\` in backgrounds), so use exactly that file there, in \`next/image\`, \`img\`, \`video\`, or the Lottie player. Images that only one theme shows (\`dark:hidden\` / \`hidden dark:block\`) are both listed: keep both, with the same classes.

${list}${sequenceBlocks(media.filter((a) => a.sequence), plan)}

Play each video with the autoplay, loop, muted, and playsinline flags from its element in the tree, and the poster file when one is listed.`
}

// Image sequences are one block each, not one line per frame.
function sequenceBlocks(frames: Asset[], plan: MediaPlan): string {
  const byId = new Map<number, Asset[]>()
  for (const f of frames) byId.set(f.sequence!.id, [...(byId.get(f.sequence!.id) ?? []), f])
  return Array.from(byId.values(), (list) => {
    list.sort((a, b) => a.sequence!.index - b.sequence!.index)
    const first = list[0]
    const firstFile = plan.names.get(first.src)
    const lastFile = plan.names.get(list.at(-1)!.src)
    const files =
      firstFile && lastFile
        ? `all ${list.length} frames are \`public/capture/${firstFile}\` … \`${lastFile}\`, in order`
        : `the ${list.length} frames weren't saved, so match the canvas from the screenshot`
    return `\n\n**Image sequence on \`${first.target}\`** (${list.length} frames, ${first.width}×${first.height}px on screen): ${files}.\nThe page draws one frame at a time as the user scrolls (the Apple-style scroll sequence). Rebuild it the same way: a \`<canvas>\` of the same size, preload every frame, and on scroll draw frame \`Math.round(progress × ${list.length - 1})\`, where progress runs over the scroll range in **Scroll story** (GSAP ScrollTrigger with \`scrub\`, or Motion's \`useScroll\`). Draw with object-fit: cover math so the frame fills the canvas.`
  }).join('')
}

function mediaLine(a: Asset, local: string | undefined): string {
  const size = a.width ? ` displayed at ${a.width}×${a.height}px` : ''
  const natural = a.naturalWidth ? ` (intrinsic ${a.naturalWidth}×${a.naturalHeight})` : ''
  const source = a.src.startsWith('data:') ? 'inline data from the page' : a.src.startsWith('blob:') ? 'a blob: URL inside the page' : `<${a.src}>`
  const missing = a.via
    ? `${source}: a streamed or embedded video, not in the zip; use its poster or the screenshot at the same size`
    : a.src.startsWith('blob:')
      ? `${source}: not in the zip; use its poster at the same size`
      : `${source}: not in the zip`
  const file = local ? `\`public/capture/${local}\` (from ${source})` : missing
  const when = a.when ? `, **shown ${a.when}**` : ''
  let line = `- ${a.kind} on \`${a.target}\`: ${file}${size}${natural}${a.alt ? `, alt ${inlineCode(a.alt)}` : ''}${when}`
  if (a.srcset) line += `\n  - srcset on the site (reference only; serve the local file): ${inlineCode(a.srcset)}`
  for (const s of a.sources ?? []) {
    const bits = [s.media && `media ${inlineCode(s.media)}`, s.type && `type ${inlineCode(s.type)}`, `srcset ${inlineCode(s.srcset)}`].filter(Boolean)
    line += `\n  - source: ${bits.join(', ')}`
  }
  return line
}

function svgSection(svgs: Asset[]): string {
  let budget = INLINE_SVG_BUDGET
  const items = svgs.map((s) => {
    const head = `${s.target} (${s.width}×${s.height}px)`
    if (s.src.length <= INLINE_SVG_MAX && s.src.length <= budget) {
      budget -= s.src.length
      return `${head}:\n\`\`\`svg\n${s.src}\n\`\`\``
    }
    return `${head}: ${kb(s.src.length)}, ${TOO_LARGE}.`
  })
  return `## SVGs
Complete, self-contained markup: styles from the site's CSS (fill, stroke, opacity, animations) are baked in, and the gradients, filters, masks and sprite symbols it references are included. Use it as-is (the tree refers to each as "inline SVG #n"):
${items.join('\n')}`
}
