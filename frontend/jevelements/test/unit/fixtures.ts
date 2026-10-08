import type { Capture, CapturedNode } from '../../src/shared/types'

export function node(partial: Partial<CapturedNode> & Pick<CapturedNode, 'tag'>): CapturedNode {
  return {
    attrs: {},
    box: { x: 0, y: 0, w: 200, h: 40 },
    styles: {},
    children: [],
    ...partial,
  }
}

// The smallest capture buildPrompt accepts: a <section> with a heading and a button.
export function minimalCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    url: 'https://example.com/',
    title: 'Example',
    capturedAt: '2026-01-01T00:00:00.000Z',
    selector: 'section#hero',
    viewport: { w: 1440, h: 900, dpr: 2 },
    root: node({
      tag: 'section',
      id: 'hero',
      box: { x: 0, y: 0, w: 1440, h: 600 },
      styles: { display: 'flex', 'flex-direction': 'column' },
      children: [
        node({ tag: 'h1', text: 'Ship faster', styles: { 'font-size': '56px' } }),
        node({ tag: 'a', classes: ['cta'], attrs: { href: '/start' }, text: 'Get started' }),
      ],
    }),
    assets: [],
    fonts: [],
    responsive: [],
    keyframes: [],
    animations: [],
    libraries: [],
    embeds: [],
    pageMedia: [],
    nodeCount: 3,
    hiddenNodes: 0,
    truncated: false,
    unreadableStylesheets: 0,
    ...overrides,
  }
}

export function richCapture(): Capture {
  return minimalCapture({
    libraries: [{ name: 'GSAP', version: '3.12.5' }],
    assets: [
      { kind: 'svg', src: '<svg viewBox="0 0 10 10"><circle r="5"/></svg>', target: 'svg.logo', width: 10, height: 10 },
      { kind: 'image', src: 'https://example.com/hero.png', target: 'img.hero', alt: 'Hero', width: 800, height: 400 },
    ],
    saved: { files: { 'https://example.com/hero.png': 'hero.png' }, uploaded: ['capture/hero.png'], archive: 'hero-section.zip', failed: [] },
    project: { name: 'hero-section', zip: 'http://localhost:3000/hero-section.zip' },
    interactions: {
      tested: { hover: 1, click: 1 },
      skipped: [],
      items: [
        {
          kind: 'hover',
          target: 'a.cta',
          text: 'Get started',
          similar: 0,
          signal: 'cursor',
          changes: ['color: rgb(0, 0, 0) → rgb(255, 0, 0)'],
          appeared: [],
          disappeared: [],
          animations: [],
          restored: true,
        },
        {
          kind: 'click',
          target: 'button.tab',
          text: 'Pricing',
          similar: 0,
          signal: 'role',
          changes: [],
          appeared: ['div.panel "Plans"'],
          disappeared: [],
          animations: [],
          restored: true,
        },
      ],
    },
    code: [
      {
        url: 'https://example.com/app.js',
        reasons: ['GLSL shaders'],
        shaders: ['void main() { gl_FragColor = vec4(1.0); }'],
        excerpt: 'createCanvas({color:"#f00"})',
        size: 2048,
      },
    ],
    embeds: [{ kind: 'WebGL canvas', target: 'canvas.bg', box: { x: 0, y: 0, w: 1440, h: 600 }, detail: 'webgl2' }],
  })
}
