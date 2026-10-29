import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/components/markdown'

const render = (content: string) => renderToStaticMarkup(<Markdown content={content} />)

describe('message Markdown', () => {
  it('leaves unfinished quotations untinted', () => {
    for (const text of ['She says "hello there', 'She says “hello there', 'She says «hello there']) {
      expect(render(text)).not.toContain('<q>')
    }
  })

  it('keeps height and inch marks from starting dialogue', () => {
    for (const height of ['6’2”', '6\'2"', '6′2″', '72"']) {
      expect(render(`He is ${height} tall and waits nearby.`)).not.toContain('<q>')
      const html = render(`He is ${height} tall. "Hello," he says.`)
      expect(html.match(/<q>/g)).toHaveLength(1)
      expect(html).toContain('<q>&quot;Hello,&quot;</q>')
    }
  })

  it('keeps a height inside dialogue without closing the quote early', () => {
    expect(render('"He is 6\'2" tall," she says.')).toContain('<q>&quot;He is 6&#x27;2&quot; tall,&quot;</q>')
    expect(render('“He is 6’2” tall,” she says.')).toContain('<q>“He is 6’2” tall,”</q>')
  })

  it('highlights complete quotes across inline formatting', () => {
    expect(render('She says "hello **there**, friend."')).toContain('<q>&quot;hello <strong>there</strong>, friend.&quot;</q>')
    expect(render('“Hello.” «Welcome.»')).toContain('<q>“Hello.”</q>')
    expect(render('“Hello.” «Welcome.»')).toContain('<q>«Welcome.»</q>')
  })

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
