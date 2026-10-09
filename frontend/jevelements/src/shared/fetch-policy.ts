// Which page-supplied URLs the service worker may download. The worker has host access to every
// site, so the page must not be able to point it at an intranet or loopback address.

// Loopback, private, link-local and CGNAT addresses, and the names that resolve to them.
// `hostname` is URL.hostname: lowercase, IPv4 normalized to dotted form, IPv6 in [brackets].
export function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  const v6 = hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (!v6.includes(':')) return false
  return v6 === '::' || v6 === '::1' || /^(fc|fd|fe[89ab])/.test(v6) || v6.startsWith('::ffff:')
}

// Why `src` must not be downloaded for a capture of `pageUrl`, or null when it may be.
export function blockedMediaUrl(src: string, pageUrl: string | undefined): string | null {
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return 'not a valid URL'
  }
  if (url.protocol === 'data:') return null // inline data makes no network request
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http(s) and data: files are downloaded'
  if (isPrivateHost(url.hostname) && !pageIsPrivate(pageUrl)) return 'a private-network address'
  return null
}

function pageIsPrivate(pageUrl: string | undefined): boolean {
  if (!pageUrl) return false
  try {
    return isPrivateHost(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}
