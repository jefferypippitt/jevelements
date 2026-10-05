// Animation, 3D, scroll and slider libraries the page uses, from their globals and DOM markers.
import type { Library } from '../shared/types'

export function detectLibraries(): Library[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probing arbitrary page globals
  const w = window as unknown as Record<string, any>
  const found: Library[] = []
  const add = (name: string, version?: unknown) => found.push({ name, version: version ? String(version) : undefined })
  const has = (selector: string) => {
    try {
      return !!document.querySelector(selector)
    } catch {
      return false
    }
  }

  if (w.gsap) add('GSAP', w.gsap.version)
  else if (w.TweenMax || w.TweenLite) add('GSAP (TweenMax)', w.TweenMax?.version)
  // Bundled GSAP has no global, but it tags every element it animates.
  else if (Array.from(document.querySelectorAll('*')).slice(0, 5000).some((el) => '_gsap' in el)) add('GSAP')
  if (w.ScrollTrigger || has('.pin-spacer')) add('GSAP ScrollTrigger')
  if (w.SplitText) add('GSAP SplitText')
  if (w.THREE || w.__THREE__) add('three.js', w.THREE?.REVISION ? `r${w.THREE.REVISION}` : w.__THREE__ ? `r${w.__THREE__}` : undefined)
  if (w.PIXI) add('PixiJS', w.PIXI.VERSION)
  if (w.BABYLON) add('Babylon.js', w.BABYLON.Engine?.Version)
  if (w.p5) add('p5.js', w.p5.VERSION)
  if (w.OGL) add('OGL')
  if (w.lottie || w.bodymovin) add('Lottie (lottie-web)', (w.lottie ?? w.bodymovin).version)
  if (customElements.get('dotlottie-player') || customElements.get('dotlottie-wc')) add('dotLottie player')
  if (w.rive) add('Rive')
  if (customElements.get('spline-viewer')) add('Spline')
  if (w.UnicornStudio) add('Unicorn Studio', w.UnicornStudio.version)
  if (w.anime) add('anime.js', w.anime.version)
  if (w.Motion) add('Motion', w.Motion.version)
  if (w.MotionGlobalConfig || w.MotionHandoffAnimation || has('[data-framer-appear-id]')) add('Framer Motion')
  if (has('[data-framer-name], [data-framer-component-type]')) add('Framer (site builder)')
  if (w.Webflow || has('html[data-wf-page]')) add('Webflow', has('[data-w-id]') ? 'with Interactions' : undefined)
  if (w.Lenis || w.lenis || document.documentElement.classList.contains('lenis')) add('Lenis (smooth scroll)')
  if (w.LocomotiveScroll || has('[data-scroll-container]')) add('Locomotive Scroll')
  if (w.AOS || has('[data-aos]')) add('AOS (animate on scroll)')
  if (w.ScrollMagic) add('ScrollMagic')
  if (w.Swiper || has('.swiper-initialized, .swiper-container-initialized')) add('Swiper', w.Swiper?.version)
  if (w.Splide || has('.splide.is-initialized')) add('Splide')
  if (w.Flickity || has('.flickity-enabled')) add('Flickity')
  if (w.jQuery?.fn?.slick || has('.slick-initialized')) add('Slick')
  if (w.barba) add('Barba.js')
  if (w.Typed) add('Typed.js')
  if (w.Alpine) add('Alpine.js', w.Alpine.version)
  return found
}
