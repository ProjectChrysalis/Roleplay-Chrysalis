// Scoping for the <style> blocks a message may carry.
/** At-rules whose body holds ordinary rules, so the rules INSIDE them need
 *  scoping too. Everything else with a block (@keyframes, @font-face) holds
 *  frames or descriptors, which must be left exactly as written. */
const NESTED_AT_RULE = /^@(media|supports|container|layer|scope)\b/i

/** Per-message <style> blocks apply only inside their boundary: every rule's
 *  selectors get the prefix. The default `.mes_text` keeps user Custom CSS
 *  docs working; callers with a finer boundary pass their own prefix.
 *
 *  Brace-walked rather than regex-replaced, because a regex that keys on
 *  "after a }" leaves the first rule inside every @media block unscoped, and
 *  a message's styles leaking onto the whole page is the one thing this must
 *  not allow. */
export function scopeCss(css: string, prefix = '.mes_text'): string {
  // comments go first: one sitting before a rule became part of its
  // selector, and before an @media block it hid the at-rule, so the
  // browser dropped the whole block
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let out = ''
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) { out += css.slice(i); break }
    const prelude = css.slice(i, open)
    // find this block's matching close, respecting nesting
    let level = 1
    let j = open + 1
    for (; j < css.length && level > 0; j++) {
      if (css[j] === '{') level++
      else if (css[j] === '}') level--
    }
    const body = css.slice(open + 1, level === 0 ? j - 1 : j)
    // statement at-rules (@import, @charset) end at a semicolon and are not
    // part of the selector that follows them. @import is dropped: a message
    // never loads a stylesheet from elsewhere
    const statementsEnd = prelude.lastIndexOf(';') + 1
    out += prelude.slice(0, statementsEnd).replace(/@import\b[^;]*;/gi, '')
    const trimmed = prelude.slice(statementsEnd).trim()
    if (trimmed.startsWith('@')) {
      out += prelude.slice(statementsEnd) + '{' + (NESTED_AT_RULE.test(trimmed) ? scopeCss(body, prefix) : body) + '}'
    } else {
      const scoped = trimmed
        .split(',')
        .map((sel) => sel.trim())
        .filter(Boolean)
        .map((sel) => `${prefix} ${sel}`)
        .join(', ')
      out += (scoped ? scoped : prefix) + '{' + body + '}'
    }
    i = j
  }
  return out
}

/** Escape a value for use inside a double-quoted CSS attribute selector. */
export function cssAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
