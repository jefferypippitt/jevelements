// Makes the page's scripts see an emulated OS colour scheme for the light/dark comparison
// (content/scheme.ts), which emulates it for the CSS. A theme script (next-themes, a "system" toggle)
// asks matchMedia('(prefers-color-scheme: dark)') and listens for its `change` event: while a scheme
// is emulated, `matches` answers for it, and when it switches, the listeners hear it like a real OS
// switch. Only lists a listener was added to can be told, so they're remembered as listeners arrive.
//
// It needs the page's own world (the content script's matchMedia is a different one), so it runs here.
import { emulateColorScheme, mentionsColorScheme, PROBE_SCHEME_ATTR, PROBE_SCHEME_EVENT } from '../shared/runtime'

const SAFETY_MS = 120_000 // stops emulating if the content script never says so

type Scheme = 'light' | 'dark'

export function installSchemeEmulation() {
  const proto = MediaQueryList.prototype
  const matches = Object.getOwnPropertyDescriptor(proto, 'matches')?.get
  const onchange = Object.getOwnPropertyDescriptor(proto, 'onchange')
  if (!matches || !onchange?.set) return
  const realMatchMedia = window.matchMedia.bind(window)
  const listened = new Set<MediaQueryList>()
  let scheme: Scheme | null = null
  let timer = 0

  const answer = (list: MediaQueryList, as: Scheme | null): boolean =>
    as && mentionsColorScheme(list.media) ? matches.call(realMatchMedia(emulateColorScheme(list.media, as))) : matches.call(list)

  Object.defineProperty(proto, 'matches', {
    configurable: true,
    enumerable: true,
    get(this: MediaQueryList) {
      return answer(this, scheme)
    },
  })
  const remember = (list: MediaQueryList) => {
    if (mentionsColorScheme(list.media)) listened.add(list)
  }
  const addEventListener = proto.addEventListener
  proto.addEventListener = function (this: MediaQueryList, ...args: Parameters<MediaQueryList['addEventListener']>) {
    remember(this)
    return addEventListener.apply(this, args)
  } as MediaQueryList['addEventListener']
  const addListener = proto.addListener
  proto.addListener = function (this: MediaQueryList, ...args: Parameters<MediaQueryList['addListener']>) {
    remember(this)
    return addListener.apply(this, args)
  }
  Object.defineProperty(proto, 'onchange', {
    ...onchange,
    set(this: MediaQueryList, handler: MediaQueryList['onchange']) {
      remember(this)
      onchange.set!.call(this, handler)
    },
  })

  const set = (next: Scheme | null) => {
    const before = scheme
    scheme = next
    clearTimeout(timer)
    const html = document.documentElement
    if (next) {
      html.setAttribute(PROBE_SCHEME_ATTR, next)
      timer = window.setTimeout(() => set(null), SAFETY_MS)
    } else html.removeAttribute(PROBE_SCHEME_ATTR)
    for (const list of listened) {
      const now = answer(list, next)
      if (now !== answer(list, before)) list.dispatchEvent(new MediaQueryListEvent('change', { media: list.media, matches: now }))
    }
  }
  document.addEventListener(PROBE_SCHEME_EVENT, (e) => {
    const detail = (e as CustomEvent<unknown>).detail
    if (detail === 'light' || detail === 'dark') set(detail)
    else if (detail === 'off') set(null)
  })
}
