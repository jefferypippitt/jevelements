// Data shapes shared by the content script and the background worker.
// A Capture is plain JSON so it can be saved, turned into a prompt, or sent to the backend.

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface PseudoElement {
  content: string
  styles: Record<string, string>
}

export interface StateRule {
  state: string // e.g. ":hover", ":focus-visible"
  declarations: string
}

export interface CapturedNode {
  tag: string
  id?: string
  classes?: string[]
  attrs: Record<string, string>
  text?: string
  box: Box
  styles: Record<string, string>
  before?: PseudoElement
  after?: PseudoElement
  states?: StateRule[]
  authored?: string[] // original CSS rules behind an animation (keeps var(--x) that computed styles resolve away)
  hidden?: boolean // display:none when captured (inactive tab, closed menu, …): no box, but styles are exact
  motion?: string[] // properties that changed while the page sat idle, i.e. animated by JavaScript
  scroll?: string[] // properties that changed while the section was scrolled through the viewport
  // Conditional classes (dark:, group-hover:, peer-*, aria-*, data-[…]:, supports-*) whose rule was not
  // applying when captured, with what it needs and the value that showed instead (content/theme.ts).
  conditional?: string[]
  note?: string
  children: CapturedNode[]
}

export interface Asset {
  kind: 'image' | 'background' | 'mask' | 'video' | 'poster' | 'svg' | 'canvas'
  src: string // URL; SVG markup for inline SVGs; a PNG data URL for canvas snapshots
  target: string // the element that uses it
  alt?: string
  width: number
  height: number
  naturalWidth?: number
  naturalHeight?: number
  srcset?: string
  sources?: { srcset: string; media?: string; type?: string }[] // <picture> sources
  // A video that isn't a file: `ffmpeg` marks an HLS/DASH manifest behind a blob: video (matched by
  // load order), `yt-dlp` a background-video YouTube/Vimeo iframe. Neither is saved to the zip.
  via?: 'ffmpeg' | 'yt-dlp'
  file?: string // downloaded by the extension: public/capture/<file> (see Capture.saved)
  // Not on screen when the section was captured: shown later by the scroll story or an interaction,
  // e.g. "scroll 44% → 76%", "after click `button.tab.t2`".
  when?: string
  // One frame of an image sequence (frame_0001.jpg … frame_0240.jpg) that a script draws, usually onto
  // a canvas, as the page scrolls.
  sequence?: { id: number; index: number; count: number }
  look?: AssetLook // images and SVGs: how the element showing it is drawn
}

// What sits between a file and the pixels: a filter, a blend mode, and opacity from the element and its
// ancestors. An SVG file can also carry its own opacity attributes, which the rebuild gets for free.
export interface AssetLook {
  filter: string // computed, `none` when unset
  blend: string // mix-blend-mode
  opacity: number // effective: the element's own opacity times every ancestor's, up to the section root
  chain?: string[] // where opacity below 1 comes from: "`div.wrap` 0.5"
  svgOpacity?: string[] // opacity attributes inside the SVG itself: `opacity="0.4"` on 12 <path>
  svgSource?: 'file' | 'markup' // svgOpacity was read from the downloaded .svg file, or the inline markup
}

export interface FontInfo {
  family: string
  weights: string[]
  styles: string[]
  links: string[] // font stylesheet links (Google Fonts, Adobe Fonts, …)
  faces: string[] // the site's @font-face rules for this family, with absolute URLs
  files: string[] // font file URLs from those rules
  fallback?: string[] // the site's metric-matched fallback faces (next/font's "<Family> Fallback" with size-adjust, ascent-override)
}

export interface ResponsiveRule {
  media: string // the @media/@container condition, or for a selector variant what it needs
  selector: string
  declarations: string
  kind?: 'selector' // a theme variant switched by a selector (`.dark\:invert:is(.dark *)`), not a media query
}

// ---------- theme (src/content/theme.ts, src/content/scheme.ts) ----------
// How the site turns its `dark:` styles on, and whether the section reacts to the OS colour scheme.

export interface DarkVariant {
  kind: 'class' | 'attribute' | 'media'
  trigger: string // ".dark", "[data-theme=dark]", "@media (prefers-color-scheme: dark)"
  example: string // one compiled rule's selector (and condition), as the site wrote it
  rules: number // compiled `dark:` rules that use this trigger
  active: boolean // the section sat under the trigger when captured (or the OS matched the query)
}

export interface ThemeInfo {
  html: Record<string, string> // class, data-theme, style, … on <html>, when set
  body: Record<string, string>
  colorScheme: { html: string; body: string; section: string } // computed color-scheme
  osDark: boolean // prefers-color-scheme: dark matched while capturing
  stored?: string // a theme the page keeps in localStorage ("light", "dark", "system")
  methods: DarkVariant[] // how `dark:` is switched, most rules first; empty when the CSS has no dark: rules
  darkClasses: number // elements in the section that carry a dark: class
}

// The section captured once under each OS colour scheme, emulated in the page (content/scheme.ts).
export interface SchemeCheck {
  differs: boolean
  differences: string[] // "`img.logo` filter: none → invert(1)"
  pixels?: string // how many pixels changed between light and dark, against two light shots
  shots?: { light: string; dark: string } // PNG data URLs, until uploaded (media.ts)
  files?: { light: string; dark: string } // names in public/reference/
  media?: Asset[] // images only the dark scheme shows (<picture> sources for prefers-color-scheme)
  partial?: string // what the emulation couldn't reach (an unreadable cross-origin sheet, the page's scripts)
  error?: string // the comparison couldn't run
}

// An animation created with the Web Animations API (Motion, Framer Motion, GSAP's WAAPI mode, …).
export interface ScriptAnimation {
  target: string
  keyframes: string[]
  timing: string
  scrollDriven: boolean
}

// What a script did to the section during the idle watch: text swaps, class changes, nodes added.
export interface SimulationEvent {
  t: number // seconds from the start of the watch
  target: string
  change: string
}

export interface Simulation {
  durationMs: number
  events: SimulationEvent[]
  texts: TextAnimation[] // text that a script typed, counted, scrambled or cycled during the watch
  idle: boolean // nothing moved and no script changed the tree
  settled?: number // style changes left out: a :hover/:focus transition finishing, not a script
}

// One element's text changing over time, from every DOM mutation during the idle watch, or a
// split-text reveal (one span per word or letter, animated with a stagger).
export interface TextAnimation {
  target: string
  kind: 'typing' | 'deleting' | 'counter' | 'scramble' | 'cycle' | 'stream' | 'split' | 'changes'
  summary: string // e.g. "types 42 characters in 1.3s (~32 chars/s)"
  values: string[] // the texts in order (first, …, last), clipped
  timing: string // e.g. "every ~40ms", "stagger 30ms per word, 600ms each"
}

export interface Library {
  name: string
  version?: string
}

// Canvas, WebGL and third-party embeds: their pixels can't be read as DOM, so they're described instead.
export interface Embed {
  kind: string
  target: string
  box: Box
  detail: string
  src?: string
  offscreen?: boolean // a canvas handed to a Web Worker (transferControlToOffscreen): it draws off the main thread
}

// A script of the page that holds a canvas's drawing code: its shaders (GLSL or WGSL string literals),
// the component that renders the canvas (found by the class names around it), or a chunk one of those
// loads. Saved to public/reference/code/<file> so the agent can port the original.
export interface CodeRef {
  url: string
  file?: string // name in public/reference/code/, once uploaded
  reasons: string[] // "GLSL shaders", "renders `canvas.block` (matches its container's classes)"
  shaders: string[] // GLSL or WGSL literals as written in the script (pieces the code concatenates)
  excerpt?: string // the code around the component match
  unreachable?: string[] // chunks this script loads that couldn't be fetched (cross-origin without CORS, gone)
  size: number
  text?: string // the whole script, until it's uploaded (media.ts)
}

// ---------- runtime data (from the page probe, src/probe) ----------
// What the page's own JavaScript knows and the DOM doesn't. Targets are element labels (tag#id.class).

export interface ShaderSource {
  name: string // material or program name
  vertex: string
  fragment: string
  uniforms?: string[] // "uTime: 12.3 (changes every frame)", "uColor: #ff3366", …
}

export interface ThreeData {
  target: string // the renderer's canvas
  revision?: string
  renderer: string[] // settings: pixel ratio, tone mapping, color space, clear color, shadows, …
  camera?: string
  scene: string[] // indented outline of the scene graph
  materials: string[]
  shaders: ShaderSource[] // ShaderMaterial / RawShaderMaterial sources
  postprocessing: ShaderSource[] // full-screen passes rendered after the main scene
  textures: string[] // image/video URLs used as textures
  sceneJson?: string // Object3D.toJSON() of the main scene: loadable with THREE.ObjectLoader
  sceneJsonError?: string
}

export interface WebGLData {
  target: string // the canvas
  context: string // "webgl2 {antialias: true, alpha: true, …}", or "webgpu"
  programs: ShaderSource[]
  wgsl?: string[] // WebGPU shader modules (createShaderModule) of the device that draws this canvas
  textures: string[]
}

export interface GsapTween {
  id: number
  code: string // e.g. gsap.to([".hero h1"], { y: 0, opacity: 1, duration: 1.2, ease: "power3.out" })
  timeline?: number
  start: number // seconds into its parent timeline
}

export interface GsapTimeline {
  id: number
  code: string // gsap.timeline({ repeat: -1, defaults: { … } })
  duration: number
  timeline?: number // parent timeline
  start: number
}

export interface GsapScrollTrigger {
  trigger: string
  config: string // { start: "top 80%", end: "bottom top", scrub: 1, pin: true, … }
  range: string // resolved scroll positions, e.g. "1200px → 2400px"
  animation?: number // tween or timeline id
}

export interface GsapData {
  version?: string
  tweens: GsapTween[]
  timelines: GsapTimeline[]
  scrollTriggers: GsapScrollTrigger[]
  bundled: boolean // GSAP runs without a global, so its timelines couldn't be read
}

export interface LottieData {
  target: string
  settings: string // renderer, loop, autoplay, speed, frame rate, frames, size
  url?: string // the animation file, when it was loaded from a URL
  json?: string // the animation data itself
}

// A live physics world. Bodies are already sentences: the probe reads the engine, it does not
// re-simulate it. Matter bodies that sit on a DOM node name that node.
export interface PhysicsWorld {
  engine: 'matter' | 'cannon' | 'rapier'
  gravity: string
  bodies: string[]
  constraints: string[]
  mouse?: string
  note?: string
}

// A page transition registered on the page (Barba, Swup, the View Transition API). `code` is the
// leave/enter functions as written, so a stairs or pixel transition can be ported from the original.
export interface PageTransition {
  library: string
  summary: string
  steps: string[]
  code?: { label: string; source: string }[]
}

export interface RuntimeData {
  libraries: Library[]
  three: ThreeData[]
  webgl: WebGLData[]
  gsap?: GsapData
  lottie: LottieData[]
  physics?: PhysicsWorld[]
  transitions?: PageTransition[]
  smoothScroll?: string // e.g. Lenis options
  lateProbe: boolean // the probe arrived after the page loaded, so it missed three.js scenes and shader sources
  workers: string[] // Web Worker scripts the page started (an OffscreenCanvas may draw from one)
  offscreen: string[] // canvases in the section that a Web Worker draws (transferControlToOffscreen)
}

// ---------- scroll story (src/content/scroll.ts) ----------
// Scroll-driven storytelling: pinned sections that step through phases, text and images that swap,
// reveals, parallax. Progress is a % of the recorded scroll range, which starts when the section (or
// its pin spacer / sticky track / ScrollTriggers) enters the viewport and ends when it leaves.

export interface ScrollPhase {
  from: number // % of the scroll range
  to: number
  scrollFrom: number // page scroll position, px
  scrollTo: number
  kind: 'change' | 'hold' // something animates in this stretch, or everything sits still
  changes: string[] // what changed, e.g. `h2.title` opacity 0 → 1; text "A" → "B"
}

export interface ScrollStory {
  start: number // page scroll px at 0%
  end: number // page scroll px at 100%
  viewport: { w: number; h: number }
  samples: number
  pinned: { target: string; from: number; to: number }[] // stays put in the viewport while the page scrolls (pin / sticky)
  continuous: string[] // values that change with nearly every scroll step (parallax, scrubbed progress)
  phases: ScrollPhase[]
  events: SimulationEvent[] // DOM changes while scrolling; `t` is the progress % instead of seconds
  media?: Asset[] // every image/video/background seen while scrolling; merged into Capture.assets, then dropped
}

// ---------- interactions (src/content/interactions.ts) ----------
// Hovers and clicks played on the live page with synthetic pointer events, and what they changed.
// What follows the pointer's position is mapped by the hover sweep instead (HoverSweep).

export interface Interaction {
  kind: 'hover' | 'click'
  target: string // element label, as in the tree
  text?: string // its visible text or aria-label
  similar: number // elements that look the same and weren't played (cards in a grid, carousel dots)
  signal: string // why it was played: "JS listener", "React handler", "aria-expanded", …
  changes: string[] // `el` prop: before → after, class/text/attribute changes
  appeared: string[] // content shown or added: revealed panels, menus, portals outside the section
  disappeared: string[]
  animations: string[] // transitions and animations that ran, with duration and easing
  restored: boolean // the section went back to how it was afterwards
  // What kept changing after the click settled, step by step: a mock UI playing a sequence (a message
  // streams in, a tool runs, a diff appears).
  phases?: InteractionPhase[]
  // The region whose content the click (and its phases) replaced, read as a full tree at the end: an
  // alternate state of the section, built like the main tree.
  layers?: { target: string; tree: CapturedNode }[]
  // A click the state explorer played inside a component (see ComponentStates): the state it was
  // clicked in and the state it led to. These aren't undone; the explorer moves between states itself.
  state?: { component: string; from: string; to: string }
}

// ---------- component states (src/content/states.ts) ----------
// A component that holds several states behind its own controls: a mock IDE whose sidebar switches
// agents, each with its own tabs, file tree and panes; tabs whose panels hold more tabs. Explored as
// a graph: every state its controls lead to, including the controls that only exist in a state a
// click brought up. Each state is the whole component read again (sidebar, tab strip and panes
// together, not just the part that changed), with parts already seen in an earlier state folded away.

export interface ComponentState {
  id: string // "S0" is the initial state (in the main tree), then "S1", "S2", … in the order found
  // How to get here from S0: the clicks, as `label` "text"
  path: string[]
  tree?: CapturedNode // missing for S0; '…' nodes whose note says "same as in S…" stand for unchanged parts
  // Menus, popovers and dialogs open in this state, rendered on <body> outside the component (portals)
  portals?: { target: string; tree: CapturedNode }[]
}

export interface StateTransition {
  from: string
  to: string
  control: string // `label` "text" of what was clicked
}

export interface ComponentStates {
  target: string // the component's root element
  signal: string // why it was explored as one component: "mock UI (aria-hidden demo)", "tabs"
  states: ComponentState[]
  transitions: StateTransition[]
  unexplored: string[] // controls left when the time or state budget ran out
  restored: boolean // it was back in S0 at the end
}

export interface InteractionPhase {
  at: number // ms after the click
  changes: string[]
  appeared: string[]
}

export interface InteractionReport {
  tested: { hover: number; click: number }
  skipped: string[] // left alone on purpose: "button "Delete account" (destructive)"
  navigates?: string[] // controls whose click leaves the page (cancelled by the guard): "`a.cta` "Watch" opens <url> in a new tab"
  items: Interaction[] // only interactions that changed something
  components?: ComponentStates[] // components whose nested states were explored click by click
  media?: Asset[] // images and videos that hovers and clicks brought on screen; merged into Capture.assets
}

// ---------- hover sweep (src/content/sweep.ts) ----------
// What follows the pointer's position, in a canvas (a shader, a 2D drawing) or in the section's own
// elements (a cursor follower, a spotlight, parallax layers, tilt cards, a magnetic button): the
// pointer made one continuous stroke left to right and one top to bottom over it (and over each
// component with its own pointer effect), and its values and its pixels were read every frame. Positions are fractions of the swept box from its top-left corner,
// written as percentages.

export interface HoverSweepFrame {
  caption: string // "pointer off the section", "pointer at 30% across, 62% down"
  dataUrl?: string // JPEG; dropped once uploaded (media.ts)
  file?: string // name in public/reference/
}

export interface HoverSweep {
  kind: 'canvas' | 'section'
  target: string // the canvas, or the section
  box: { w: number; h: number }
  values: string // where the values came from: the canvas's renderer, or the elements' styles
  measured: string // how the pixels were read: "read back from the canvas itself", "cropped from screenshots of the tab", or not at all
  swept: string // the strokes, what part of the box they covered, and the components swept on their own
  pointer: string[] // values that follow the pointer, with how they map to its position
  idle: string[] // values that change by themselves (time), so they aren't mistaken for the hover
  motion: string[] // how they get there: easing after a move, on enter, on leave
  map?: string[] // the pixel change along each stroke: left → right, then top → bottom
  hotspots: string[] // the points where the pixels changed most, and which part changed
  frames: HoverSweepFrame[]
  notes: string[]
}

// ---------- click sweep (src/content/sweep.ts) ----------
// What a click does where nothing in the markup is a control: a canvas (a ripple, a burst of
// particles, picking a 3D object) or the section's own background (click anywhere to change the color).
// The cursor is read first over a fine grid (a canvas that turns it into a pointer over a shape it
// draws), then it is clicked where the cursor changed and at a grid of points (never on links, buttons
// or other controls), with navigation and server writes blocked, each click followed frame by frame.
// A canvas is also dragged across its middle.

export interface ClickSweep {
  kind: 'canvas' | 'section'
  target: string
  box: { w: number; h: number }
  values: string // where the values came from, as in HoverSweep
  measured: string // how the pixels were read
  swept: string // how many clicks, where, and what was left out
  reactions: string[] // values a click changes: set to the click point, a pulse, a counter, a toggle
  drag?: string[] // what a drag across a canvas does beyond moving the pointer: rotate, pan, inertia, spring back
  added: string[] // elements a click adds (a ripple span), and how long they stay
  cursor?: string[] // where the cursor changes over it: "pointer over 38–62% across, 30–70% down (the shape there)"
  cursorMap?: string[] // rows of the cursor map over the fine grid
  navigates?: string[] // where a click leaves the page: "a click at 50% across, 50% down opens <url> in a new tab"
  map?: string[] // rows of the heat map: how much a click at each point changed the pixels
  hotspots: string[]
  frames: HoverSweepFrame[]
  notes: string[]
}

// The files the rebuild gets in public/: the real images, videos, canvas snapshots, textures and models
// the extension downloaded from the page (capture/), the screenshot and the canvas source code (reference/). The service
// worker uploads them to the backend, which ships them inside the app zip (see Capture.project).
export interface SavedFiles {
  files: Record<string, string> // http(s) source URL → file name in public/capture/ (data: and blob: files only on Asset.file)
  uploaded: string[] // paths under public/ that are in `archive` ("capture/image-01.jpg", "reference/section.png")
  archive?: string // backend URL of the app zip; missing when nothing could be uploaded (backend not running)
  screenshot?: string // name of the one screenshot (the initial look), in public/reference/ when uploaded
  failed: { src: string; reason: string }[]
  fonts?: Record<string, string> // font file URL → file name in public/fonts/
  fontsFailed?: { src: string; reason: string }[]
}

// ---------- parts (src/content/parts.ts) ----------
// The section's building blocks, as the picker's dotted boxes show them: its parts (wrappers with a
// single child looked through) and the parts of the bigger ones. Read when the capture starts.

export interface SectionPart {
  name: string // like the tree's element lines: tag#id.class
  kind: 'heading' | 'text' | 'media' | 'control' | 'list' | 'nav' | 'header' | 'footer' | 'form' | 'group'
  box: Box // relative to the section's top-left corner; the first one when it repeats
  text?: string // its text, shortened
  repeats?: number // siblings built the same way, in a row (cards, logos): one entry for all of them
  items?: string[] // the text of each one, when it repeats
  parts?: SectionPart[]
}

export interface Capture {
  id: string
  url: string
  title: string
  capturedAt: string
  selector: string
  viewport: { w: number; h: number; dpr: number }
  root: CapturedNode
  assets: Asset[]
  fonts: FontInfo[]
  responsive: ResponsiveRule[]
  keyframes: string[] // @keyframes (and @property rules they animate)
  animations: ScriptAnimation[]
  libraries: Library[]
  embeds: Embed[]
  pageMedia: string[] // 3D models, Lottie/Rive files, shaders and fonts the page's scripts loaded
  nodeCount: number
  hiddenNodes: number
  truncated: boolean
  unreadableStylesheets: number
  screenshot?: string // PNG data URL of the visible part of the element
  fullScreenshot?: string // JPEG data URL of the whole element, stitched while scrolling (taller than the viewport only)
  runtime?: RuntimeData
  scrollRecorded?: boolean // nodes carry `scroll` lines from scrolling the section through the viewport
  scrollStory?: ScrollStory // the scroll recording grouped into phases
  interactions?: InteractionReport // hovers and clicks played on the live page
  parts?: SectionPart[] // the section's building blocks, for the component split
  hoverSweep?: HoverSweep[] // canvases and the section, where they follow the pointer, swept left to right and top to bottom
  clickSweep?: ClickSweep[] // canvases and the section's background, clicked point by point
  code?: CodeRef[] // the page's scripts that draw the section's canvases
  saved?: SavedFiles // media file names and screenshot names the prompt refers to
  project?: CaptureProject // the app zip the extension downloaded
  simulation?: Simulation // idle watch: scripted text, structure, and style changes
  theme?: ThemeInfo // how dark mode is switched, and the theme at capture
  schemes?: SchemeCheck // the section under the light and the dark OS colour scheme
  analysis?: SectionAnalysis // added by the backend (typesafe-ai/jev) when enabled
}

// The rebuild ships as one zip: a ready Next.js app in `<name>/` with the saved files in public/ and the
// prompt as PROMPT.md (backend/src/lib/archive.ts).
export interface CaptureProject {
  name: string // "hero-section": the zip, the folder inside it, and the package name
  zip: string // backend URL of <name>.zip
}

// Returned by the backend's POST /api/analyze (backend/src/lib/analyze.ts).
export interface SectionAnalysis {
  model: string
  sectionType: { value: string; confidence: number | null }
  layout: { value: string; confidence: number | null }
  theme: { value: string; confidence: number | null }
  scope: { value: string; confidence: number | null }
  collapse: { value: string; confidence: number | null }
  repeatedGroup: { id: string; summary: string; confidence: number | null } | null
  complexity: number
  features: Record<string, number>
  nameFromType: boolean
  componentName: string | null
  promptSection: string
}

export interface Settings {
  backendUrl: string
  backendToken: string
}

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: 'http://localhost:3000',
  backendToken: '',
}

// 'jev:interrupted': the tab left the page while a capture was running there (the background worker
// sends it to the content script on the new page, which shows why the drawer vanished).
export type ContentMessage = { type: 'jev:toggle' } | { type: 'jev:interrupted'; from: string; to: string }

export type ScreenshotMessage = {
  type: 'jev:screenshot'
  rect: { x: number; y: number; w: number; h: number } // viewport coordinates, CSS px
  viewportWidth: number
}

export type AnalyzeMessage = { type: 'jev:analyze'; capture: Capture }

// Downloads one file in the service worker (host access to every site, so no CORS) and, with `upload`,
// stores it on the backend as media/<name>.<ext>. The bytes go straight from the site to the backend.
export type SaveMediaMessage = { type: 'jev:save-media'; src: string; captureId: string; name: string; upload: boolean; folder?: 'media' | 'fonts' }
export type SaveMediaResponse = { file: string; upload?: UploadResult } | { error: string }
// Bytes only the page could read (blob: URLs, cookie-bound files, canvas snapshots, screenshots), sent
// on to the backend in base64 chunks. Offset 0 starts the file; later chunks append.
export type UploadMessage = { type: 'jev:upload'; captureId: string; folder: 'media' | 'frames' | 'code' | 'fonts'; name: string; base64: string; offset: number }
// `archive` is where the rebuild downloads every uploaded file; `unreachable` means the backend isn't running.
export type UploadResult = { archive: string } | { error: string; unreachable?: boolean }

// Names the app and stores the prompt on the backend, so its zip comes out as <name>/ with PROMPT.md.
export type ProjectMessage = { type: 'jev:project'; captureId: string; name: string; component: string; file: string; prompt: string }
export type ProjectResponse = { name: string; zip: string } | { error: string }

// Makes sure the page probe is running in the tab's page world (it isn't on pages that loaded before
// the extension was installed or updated).
export type InjectProbeMessage = { type: 'jev:inject-probe' }

// A capture started (active) or ended in this tab. While one runs, a page load in the tab means it was
// interrupted.
export type CapturingMessage = { type: 'jev:capturing'; active: boolean }

export type BackgroundMessage = ScreenshotMessage | AnalyzeMessage | InjectProbeMessage | SaveMediaMessage | UploadMessage | ProjectMessage | CapturingMessage

export type ScreenshotResponse = { dataUrl: string } | { error: string }

export type AnalyzeResponse = { analysis: SectionAnalysis } | { error: string }
