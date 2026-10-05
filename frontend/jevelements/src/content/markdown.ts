// Renders the capture prompt in the result drawer.
// The prompt is markdown. Copy still uses the original string; this view is for reading.
// Nodes are created with DOM APIs so captured page text is never parsed as HTML.
// Styling is the .typeset container in overlay.css (shadcn/typeset).

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'link'; href: string }

type Block =
  | { kind: 'heading'; level: HeadingLevel; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; items: ListItem[] }

interface ListItem {
  checked: boolean | null // null: ordinary item. true/false: a task checkbox
  text: string
  children: Block[]
}

const HEADING_TAG: Record<HeadingLevel, 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'> = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
  5: 'h5',
  6: 'h6',
}

export function renderPrompt(markdown: string): HTMLDivElement {
  const root = document.createElement('div')
  root.className = 'typeset typeset-prompt'
  root.tabIndex = 0
  root.setAttribute('aria-label', 'Prompt')
  appendBlocks(root, parseMarkdown(markdown))
  // Keep keys inside the prompt from triggering the host page's shortcuts.
  root.addEventListener('keydown', (event) => event.stopPropagation())
  return root
}

function parseMarkdown(markdown: string): Block[] {
  return parseBlocks(markdown.split(/\r?\n/))
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++
      continue
    }
    if (fenceAt(lines[i])) {
      const fence = readFence(lines, i)
      blocks.push(fence.block)
      i = fence.next
      continue
    }
    const item = listItem(lines[i])
    if (item) {
      const list = readList(lines, i, item.indent)
      blocks.push(list.block)
      i = list.next
      continue
    }
    const heading = /^(#{1,6}) (.*)$/.exec(lines[i])
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length as HeadingLevel, text: heading[2] })
      i++
      continue
    }
    const parts: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !fenceAt(lines[i]) && !listItem(lines[i]) && !/^(#{1,6}) /.test(lines[i])) {
      parts.push(lines[i].trim())
      i++
    }
    if (parts.length) blocks.push({ kind: 'paragraph', text: parts.join('\n') })
  }
  return blocks
}

function readList(lines: string[], start: number, indent: number): { block: Block; next: number } {
  const items: ListItem[] = []
  let i = start
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      const ahead = j < lines.length ? listItem(lines[j]) : null
      if (!ahead || ahead.indent !== indent) break
      i = j
    }
    const item = listItem(lines[i])
    if (!item || item.indent !== indent) break
    i++
    const task = /^\[([ xX])\] (.*)$/.exec(item.text)
    const li: ListItem = {
      checked: task ? task[1] !== ' ' : null,
      text: task ? task[2] : item.text,
      children: [],
    }
    while (i < lines.length) {
      const current = lines[i]
      if (current.trim() === '') break
      const nested = listItem(current)
      if (nested && nested.indent <= indent) break
      if (nested) {
        const child = readList(lines, i, nested.indent)
        li.children.push(child.block)
        i = child.next
        continue
      }
      if (fenceAt(current) && indentOf(current) >= indent) {
        const fence = readFence(lines, i)
        li.children.push(fence.block)
        i = fence.next
        continue
      }
      if (indentOf(current) <= indent) break
      const parts: string[] = []
      while (i < lines.length && lines[i].trim() !== '' && !listItem(lines[i]) && !fenceAt(lines[i]) && indentOf(lines[i]) > indent) {
        parts.push(lines[i].trim())
        i++
      }
      if (parts.length) li.children.push({ kind: 'paragraph', text: parts.join('\n') })
    }
    items.push(li)
  }
  return { block: { kind: 'list', items }, next: i }
}

function readFence(lines: string[], start: number): { block: Block; next: number } {
  const open = fenceAt(lines[start])
  const ticks = open?.ticks ?? '```'
  const lang = open?.lang ?? ''
  const body: string[] = []
  let i = start + 1
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (trimmed.length >= ticks.length && trimmed.startsWith(ticks) && /^`+$/.test(trimmed)) {
      i++
      break
    }
    body.push(lines[i])
    i++
  }
  return { block: { kind: 'code', lang, text: body.join('\n') }, next: i }
}

function fenceAt(line: string): { ticks: string; lang: string } | null {
  const match = /^(\s*)(`{3,})([^`]*)$/.exec(line)
  if (!match) return null
  return { ticks: match[2], lang: match[3].trim() }
}

function listItem(line: string): { indent: number; text: string } | null {
  const match = /^(\s*)- (.*)$/.exec(line)
  if (!match) return null
  return { indent: match[1].length, text: match[2] }
}

function indentOf(line: string): number {
  let n = 0
  while (line[n] === ' ') n++
  return n
}

function appendBlocks(parent: ParentNode, blocks: Block[]) {
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        parent.append(heading(block.level, block.text))
        break
      case 'paragraph':
        parent.append(paragraph(block.text))
        break
      case 'code':
        parent.append(codeBlock(block.lang, block.text))
        break
      case 'list':
        parent.append(list(block.items))
        break
      default: {
        const unreachable: never = block
        return unreachable
      }
    }
  }
}

function heading(level: HeadingLevel, text: string): HTMLHeadingElement {
  const node = document.createElement(HEADING_TAG[level])
  appendInline(node, parseInline(text))
  return node
}

function paragraph(text: string): HTMLParagraphElement {
  const node = document.createElement('p')
  appendInline(node, parseInline(text))
  return node
}

function codeBlock(lang: string, text: string): HTMLElement {
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = text
  pre.append(code)
  if (!lang) return pre
  const figure = document.createElement('figure')
  const caption = document.createElement('figcaption')
  caption.textContent = lang
  figure.append(caption, pre)
  return figure
}

function list(items: ListItem[]): HTMLUListElement {
  const ul = document.createElement('ul')
  for (const item of items) {
    const li = document.createElement('li')
    if (item.checked !== null) {
      li.className = 'task'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.disabled = true
      box.tabIndex = -1
      box.checked = item.checked
      box.setAttribute('aria-hidden', 'true')
      li.append(box)
    }
    appendInline(li, parseInline(item.text))
    appendBlocks(li, item.children)
    ul.append(li)
  }
  return ul
}

// Inline markdown the prompt actually emits: code spans, **bold**, and <https://…> autolinks.
function parseInline(text: string): Inline[] {
  const nodes: Inline[] = []
  let i = 0
  let plain = ''
  const flush = () => {
    if (!plain) return
    nodes.push({ kind: 'text', text: plain })
    plain = ''
  }
  while (i < text.length) {
    const taken = takeToken(text, i)
    if (taken) {
      flush()
      nodes.push(taken.node)
      i += taken.size
      continue
    }
    plain += text[i]
    i++
  }
  flush()
  return nodes
}

function takeToken(text: string, i: number): { node: Inline; size: number } | null {
  if (text[i] === '`') {
    const ticks = backtickRun(text, i)
    const close = findCodeClose(text, i + ticks, ticks)
    if (close < 0) return null
    let content = text.slice(i + ticks, close)
    if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1)
    return { node: { kind: 'code', text: content }, size: close + ticks - i }
  }
  if (text.startsWith('**', i)) {
    const close = text.indexOf('**', i + 2)
    if (close < 0) return null
    return { node: { kind: 'strong', children: parseInline(text.slice(i + 2, close)) }, size: close + 2 - i }
  }
  const link = /^<(https?:\/\/[^>\s]+)>/.exec(text.slice(i))
  if (!link?.[1]) return null
  return { node: { kind: 'link', href: link[1] }, size: link[0].length }
}

function appendInline(parent: ParentNode, nodes: Inline[]) {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        parent.append(document.createTextNode(node.text))
        break
      case 'code': {
        const code = document.createElement('code')
        code.textContent = node.text
        parent.append(code)
        break
      }
      case 'strong': {
        const strong = document.createElement('strong')
        appendInline(strong, node.children)
        parent.append(strong)
        break
      }
      case 'link': {
        const anchor = document.createElement('a')
        anchor.href = node.href
        anchor.textContent = node.href
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer'
        parent.append(anchor)
        break
      }
      default: {
        const unreachable: never = node
        return unreachable
      }
    }
  }
}

function backtickRun(text: string, i: number): number {
  let n = 0
  while (text[i + n] === '`') n++
  return n
}

// A closing run of exactly `length` backticks, not part of a longer run.
function findCodeClose(text: string, from: number, length: number): number {
  for (let j = from; j <= text.length - length; j++) {
    if (text[j - 1] === '`') continue
    let n = 0
    while (text[j + n] === '`') n++
    if (n === length) return j
    if (n > 0) j += n - 1
  }
  return -1
}
