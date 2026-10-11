import { expect, it } from 'bun:test'
import { fitComposerInput } from '../src/lib/composer-size'

function input(width: number, contentHeight: number, height = 80, visible = true) {
  return { clientWidth: width, scrollHeight: contentHeight, get offsetHeight() { return Number.parseFloat(this.style.height) }, getClientRects: () => ({ length: visible ? 1 : 0 }), style: { height: `${height}px` } }
}

it('preserves the input height while its app frame is hidden', () => {
  for (const box of [input(0, 0), input(500, 0, 80, false)]) {
    expect(fitComposerInput(box)).toBe(0)
    expect(box.style.height).toBe('80px')
  }
})
it('refits after the frame returns and shrinks a cleared draft to one line', () => {
  const box = input(0, 0)
  fitComposerInput(box)
  box.clientWidth = 500
  box.scrollHeight = 120
  expect(fitComposerInput(box)).toBe(40)
  expect(box.style.height).toBe('120px')
  box.scrollHeight = 34
  expect(fitComposerInput(box)).toBe(-84)
  expect(box.style.height).toBe('36px')
})
it('keeps a visible input usable when layout has not reported its content height', () => {
  const box = input(500, 0)
  fitComposerInput(box)
  expect(box.style.height).toBe('36px')
})
