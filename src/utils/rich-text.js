// ── Rich-text comments ───────────────────────────────────────────────
// Review comments can be typed in the rich-text editor (bold, italic,
// underline, bullet and numbered lists) or be plain text from before the
// editor existed. Everything that DISPLAYS a comment — the admin panel,
// the applicant's page, the comments thread and the emails — goes through
// commentToHtml() so they all look the same.
//
// The sanitiser is an allowlist: only the tags below survive, every
// attribute is dropped, and all other markup is removed (its text is kept).
// No dependencies, so the identical file is used in the React frontend
// (Applications/rich-text.js) and the erb-helper backend (src/utils/rich-text.js).

const TAG_MAP = {
  b: 'strong', strong: 'strong',
  i: 'em', em: 'em',
  u: 'u',
  p: 'p', div: 'p',
  br: 'br',
  ul: 'ul', ol: 'ol', li: 'li',
}

// Inline styles so lists show bullets/numbers even where CSS resets remove
// them (Tailwind's preflight on the admin side, and email clients).
export const DEFAULT_STYLES = {
  p:  'margin:0 0 4px;',
  ul: 'margin:4px 0 6px;padding-left:22px;list-style-type:disc;',
  ol: 'margin:4px 0 6px;padding-left:22px;list-style-type:decimal;',
  li: 'margin:2px 0;',
}

const RICH_TAG = /<\/?(b|strong|i|em|u|p|div|br|ul|ol|li)\b[^>]*>/i
const TAG      = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g

export const isRichText = (s) => RICH_TAG.test(String(s ?? ''))

const escapeText = (s) => String(s)
  .replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const open = (tag, styles) => (styles && styles[tag] ? `<${tag} style="${styles[tag]}">` : `<${tag}>`)

// Allowlist-sanitise rich text. `styles` = null stores clean markup;
// pass DEFAULT_STYLES (or your own) when rendering.
export function sanitizeRichText(input, styles = null) {
  const src = String(input ?? '')
    .replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  let out = ''
  const stack = []
  const closeTo = (idx) => { while (stack.length > idx) out += `</${stack.pop()}>` }
  const push = (tag) => { out += open(tag, styles); stack.push(tag) }
  // Loose text at the top level goes in a paragraph (browsers leave the
  // first line of an editor bare), so every line is a block in emails too.
  const ensureBlock = () => {
    if (!stack.some(t => t === 'p' || t === 'li' || t === 'ul' || t === 'ol')) {
      const inline = stack.splice(0)
      inline.forEach(t => { out += `</${t}>` })
      push('p')
      inline.forEach(push)
    }
  }
  const text = (s) => {
    if (!s) return
    if (/\S/.test(s)) ensureBlock()
    out += escapeText(s)
  }

  let last = 0
  TAG.lastIndex = 0
  let m
  while ((m = TAG.exec(src)) !== null) {
    text(src.slice(last, m.index))
    last = TAG.lastIndex
    const closing = m[1] === '/'
    const tag = TAG_MAP[m[2].toLowerCase()]
    if (!tag) continue
    if (tag === 'br') { ensureBlock(); out += '<br>'; continue }

    if (closing) {
      const idx = stack.lastIndexOf(tag)
      if (idx !== -1) closeTo(idx)
      continue
    }
    if (tag === 'p' || tag === 'ul' || tag === 'ol') {
      // A paragraph can't hold another block (Chrome's editor nests them):
      // close it first, as an HTML parser would.
      const p = stack.lastIndexOf('p')
      if (p !== -1 && p > stack.lastIndexOf('li')) closeTo(p)
    } else if (tag === 'li') {
      const li = stack.lastIndexOf('li')
      if (li !== -1 && li > Math.max(stack.lastIndexOf('ul'), stack.lastIndexOf('ol'))) closeTo(li)
    } else {
      ensureBlock()
    }
    push(tag)
  }
  text(src.slice(last))
  closeTo(0)

  // Drop empty paragraphs/list items the editor leaves behind.
  return out.replace(/<(p|li)(?: style="[^"]*")?>(?:\s|&nbsp;|<br>)*<\/\1>/g, '').trim()
}

// ── Plain-text comments ──────────────────────────────────────────────
// Officers often paste whole review notes as one paragraph, e.g.
//   "ERB REGISTRATION COMMENTS NOTE: … CAREER REPORT i. … ii. …
//    TECHNICAL REPORT i. … ii. … xii. …"
// We rebuild the structure from that:
//   • list markers 1. 2. 3. / i. ii. iii. / I. II. / a. b. c. / A. B.
//     (also "1)" and "(i)"), counted only when they run in order from the
//     first value, so "Phase 2. Done" or "e.g." are left alone;
//   • a new run starting again at 1 / i / a begins a new list;
//   • words IN CAPITALS just before a list ("CAREER REPORT") become a
//     bold heading, as does a line typed entirely in capitals.

const ROMAN = ['i','ii','iii','iv','v','vi','vii','viii','ix','x','xi','xii','xiii','xiv','xv',
  'xvi','xvii','xviii','xix','xx','xxi','xxii','xxiii','xxiv','xxv','xxvi','xxvii','xxviii','xxix','xxx']

const MARKER_RE = /(^|\s)(?:\(([0-9]{1,2}|[ivxIVX]{1,6}|[a-zA-Z])\)|([0-9]{1,2}|[ivxIVX]{1,6}|[a-zA-Z])[.)])(?=\s)/g

// Every list kind this marker could belong to, with its position in that kind.
function markerKinds(tok) {
  const kinds = []
  if (/^\d+$/.test(tok)) kinds.push({ kind: 'num', n: Number(tok) })
  const r = ROMAN.indexOf(tok.toLowerCase())
  if (r !== -1 && (tok === tok.toLowerCase() || tok === tok.toUpperCase())) {
    kinds.push({ kind: tok === tok.toLowerCase() ? 'roman' : 'ROMAN', n: r + 1 })
  }
  if (/^[a-z]$/.test(tok)) kinds.push({ kind: 'alpha', n: tok.charCodeAt(0) - 96 })
  if (/^[A-Z]$/.test(tok)) kinds.push({ kind: 'ALPHA', n: tok.charCodeAt(0) - 64 })
  return kinds
}

const LIST_STYLE = { num: 'decimal', roman: 'lower-roman', ROMAN: 'upper-roman', alpha: 'lower-alpha', ALPHA: 'upper-alpha' }

// A heading word: written in capitals (at least two capital letters), e.g.
// "CAREER", "REPORT", "NOTE:", "ERB", or "&".
const isCapsWord = (w) => w === '&' || (/^[A-Z0-9&'’()\/-]+[:.,]?$/.test(w) && (w.match(/[A-Z]/g) || []).length >= 2)

// "…subheadings. TECHNICAL REPORT" → { text: '…subheadings.', heading: 'TECHNICAL REPORT' }
function takeTrailingHeading(text) {
  const words = text.split(/\s+/).filter(Boolean)
  let k = words.length
  while (k > 0 && isCapsWord(words[k - 1])) k -= 1
  const caps = words.slice(k)
  const rest = words.slice(0, k).join(' ')
  const ok = caps.length >= 2 || (caps.length === 1 && caps[0].replace(/[^A-Z]/g, '').length >= 4 && (!rest || /[.:;!?]$/.test(rest)))
  return ok ? { text: rest, heading: caps.join(' ') } : { text, heading: '' }
}

// "ERB REGISTRATION COMMENTS NOTE: The reports…" → heading "ERB REGISTRATION COMMENTS"
function takeLeadingHeading(text) {
  const words = text.split(/\s+/).filter(Boolean)
  let k = 0
  while (k < words.length && isCapsWord(words[k])) k += 1
  if (k < words.length && k > 1 && /:$/.test(words[k - 1])) k -= 1   // keep "NOTE:" with its sentence
  if (k < 2 || k === words.length) return { heading: '', text }
  return { heading: words.slice(0, k).join(' '), text: words.slice(k).join(' ') }
}

// One typed line → blocks: { type: 'p' | 'h', text } or { type: 'list', style, items }.
function parsePlainLine(line) {
  const marks = []
  let m
  MARKER_RE.lastIndex = 0
  while ((m = MARKER_RE.exec(line)) !== null) {
    marks.push({ start: m.index + m[1].length, after: m.index + m[0].length, kinds: markerKinds(m[2] || m[3]) })
  }

  // Group markers into in-order runs; continuing the current run wins over
  // starting a new one (so in a…h, "i." is the 9th letter, not roman 1).
  const runs = []
  let cur = null
  marks.forEach((mk) => {
    const cont = cur && mk.kinds.find(k => k.kind === cur.kind && k.n === cur.next)
    if (cont) { cur.cuts.push(mk); cur.next += 1; return }
    const first = mk.kinds.find(k => k.n === 1)
    if (first) { cur = { kind: first.kind, next: 2, cuts: [mk] }; runs.push(cur) }
  })
  const lists = runs.filter(r => r.cuts.length >= 2)

  if (!lists.length) {
    const whole = line.replace(/[:.]$/, '')
    if (whole.split(/\s+/).every(isCapsWord) && whole.replace(/[^A-Z]/g, '').length >= 4 && line.length <= 80) {
      return [{ type: 'h', text: line }]
    }
    return [{ type: 'p', text: line }]
  }

  const blocks = []
  const pushText = (text, isIntro) => {
    let t = text.trim()
    if (!t) return ''
    let lead = ''
    if (isIntro) { const l = takeLeadingHeading(t); lead = l.heading; t = l.text }
    const tr = takeTrailingHeading(t)
    if (lead) blocks.push({ type: 'h', text: lead })
    if (tr.text) blocks.push({ type: 'p', text: tr.text })
    return tr.heading
  }

  let heading = pushText(line.slice(0, lists[0].cuts[0].start), true)
  lists.forEach((run, ri) => {
    if (heading) blocks.push({ type: 'h', text: heading })
    heading = ''
    const nextStart = ri + 1 < lists.length ? lists[ri + 1].cuts[0].start : line.length
    const items = run.cuts.map((c, i) => line.slice(c.after, i + 1 < run.cuts.length ? run.cuts[i + 1].start : nextStart).trim())
    // The last item may end with the next section's heading ("… TECHNICAL REPORT").
    if (ri + 1 < lists.length) {
      const tr = takeTrailingHeading(items[items.length - 1])
      if (tr.heading && tr.text) { items[items.length - 1] = tr.text; heading = tr.heading }
    }
    blocks.push({ type: 'list', style: LIST_STYLE[run.kind], items })
  })
  return blocks
}

function plainToHtml(text, styles) {
  const blocks = []
  let para = []
  const flush = () => {
    if (para.length) blocks.push(`${open('p', styles)}${para.join('<br>')}</p>`)
    para = []
  }
  const olOpen = (style) => {
    if (!styles) return '<ol>'
    let base = (styles.ol || '').replace(/list-style-type:[^;]*;?/, '')
    // Roman numerals like "viii." are wide: give them more room.
    if (/roman/.test(style)) base = base.replace(/padding-left:[^;]*;?/, '') + 'padding-left:34px;'
    return `<ol style="${base}list-style-type:${style};">`
  }
  String(text ?? '').split(/\r?\n/).forEach((raw) => {
    const line = raw.trim()
    if (!line) { flush(); return }
    parsePlainLine(line).forEach((b) => {
      if (b.type === 'p') { para.push(escapeHtml(b.text)); return }
      flush()
      if (b.type === 'h') {
        const hp = styles ? `<p style="${(styles.p || '').replace(/margin:[^;]*;?/, '')}margin:${blocks.length ? '10px' : '0'} 0 4px;">` : '<p>'
        blocks.push(`${hp}<strong>${escapeHtml(b.text)}</strong></p>`)
      }
      else blocks.push(`${olOpen(b.style)}${b.items.map(it => `${open('li', styles)}${escapeHtml(it)}</li>`).join('')}</ol>`)
    })
    flush()
  })
  flush()
  return blocks.join('')
}

// Any stored comment (rich or plain) → safe HTML for display.
export function commentToHtml(text, styles = DEFAULT_STYLES) {
  if (text === null || text === undefined || String(text).trim() === '') return ''
  return isRichText(text) ? sanitizeRichText(text, styles) : plainToHtml(text, styles)
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

// Rich text → readable plain text (for length checks, logs, previews).
export function richTextToPlain(text) {
  const s = String(text ?? '')
  if (!isRichText(s)) return s.trim()
  // Walk the sanitised markup: it only holds allowlisted, attribute-free tags.
  const clean = sanitizeRichText(s)
  const lists = []
  let out = ''
  let last = 0
  const re = /<(\/?)(p|br|ul|ol|li|strong|em|u)>/g
  let m
  while ((m = re.exec(clean)) !== null) {
    out += clean.slice(last, m.index)
    last = re.lastIndex
    const [, closing, tag] = m
    if (tag === 'br') out += '\n'
    else if (tag === 'ul' || tag === 'ol') {
      if (closing) { lists.pop(); out += '\n' } else { lists.push({ tag, n: 0 }); out += '\n' }
    } else if (tag === 'li' && !closing) {
      const list = lists[lists.length - 1]
      const indent = '  '.repeat(Math.max(lists.length - 1, 0))
      out += list && list.tag === 'ol' ? `\n${indent}${++list.n}. ` : `\n${indent}• `
    } else if (tag === 'p' && closing) out += '\n'
  }
  out += clean.slice(last)
  return out
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
