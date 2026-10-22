import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/components/markdown'

const render = (content: string) => renderToStaticMarkup(<Markdown content={content} />)

describe('message Markdown', () => {
  it('keeps single tildes literal in dialogue and narration', () => {
    const html = render('"hello~" blah blah "yes~" and ~hello~')
    expect(html).not.toContain('<del>')
    expect(html).toContain('hello~')
    expect(html).toContain('yes~')
    expect(html).toContain('~hello~')
    expect(html).toContain('<q>')
  })

  it('keeps single tildes literal throughout a streamed reply', () => {
    const text = '"hello~" she sings. "~yes~"'
    for (let end = 1; end <= text.length; end++) {
      expect(render(text.slice(0, end))).not.toContain('<del>')
    }
  })

  it('still renders deliberate double-tilde strikethrough', () => {
    expect(render('hello~ ~~changed my mind~~ yes~')).toContain('<del>changed my mind</del>')
  })

  it('preserves tildes inside code and tilde-fenced code blocks', () => {
    expect(render('`~literal~`')).toContain('<code>~literal~</code>')
    const html = render('~~~text\n~literal~ ~~also literal~~\n~~~')
    expect(html).toContain('<pre><code')
    expect(html).toContain('~literal~ ~~also literal~~')
    expect(html).not.toContain('<del>')
  })
})
