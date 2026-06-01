// Shared text-measurement utilities.
// Canvas measureText is used for speed; values are stored as em so they
// scale correctly when the user zooms the browser.

let _canvas: HTMLCanvasElement | null = null

function canvas(): CanvasRenderingContext2D | null {
  if (!_canvas) _canvas = document.createElement('canvas')
  return _canvas.getContext('2d')
}

export function getFont(el: HTMLElement): string {
  const s = window.getComputedStyle(el)
  return s.font || `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
}

export function measureTextWidth(text: string, font: string): number {
  const ctx = canvas()
  if (!ctx) return 0
  ctx.font = font
  return ctx.measureText(text).width
}
