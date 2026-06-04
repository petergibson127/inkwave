// Shared text-measurement utilities.
//
// Width is measured with a hidden DOM span rather than canvas measureText. Canvas
// can disagree with the actual rendered width — the loaded web font may not be
// available in the canvas font set, and iOS text rendering differs — which desynced
// the popover's in-place spacing on iOS. A real span is rendered by the same engine
// that paints the editor, so its width matches exactly.

export function getFont(el: HTMLElement): string {
  const s = window.getComputedStyle(el)
  return s.font || `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
}

let _span: HTMLSpanElement | null = null
function measureSpan(): HTMLSpanElement {
  if (!_span) {
    _span = document.createElement('span')
    Object.assign(_span.style, {
      position: 'absolute', left: '-9999px', top: '0',
      visibility: 'hidden', whiteSpace: 'pre', pointerEvents: 'none',
      margin: '0', padding: '0', border: '0',
    } as Partial<CSSStyleDeclaration>)
    document.body.appendChild(_span)
  }
  return _span
}

export function measureTextWidth(text: string, font: string): number {
  const span = measureSpan()
  span.style.font = font
  span.textContent = text
  return span.getBoundingClientRect().width
}
