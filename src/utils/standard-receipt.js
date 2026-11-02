// ══════════════════════════════════════════════════════════════════
// ERB standard receipt — the ONE layout every receipt uses
// ══════════════════════════════════════════════════════════════════
// Approved design ("option B", Nov 2026): centred letterhead with the
// coloured ERB logo, everything else black on white, Goudy type with
// lining figures, "Received from" / "Payment details" panels, an itemised
// table and a boxed TOTAL PAID.
//
// Every receipt the system issues is drawn here — application,
// registration and renewal fees (utils/receipt-pdf.js → generateReceiptPdf),
// staff-created receipts (routes/sent_receipt_routes.js), annual licence
// and WED receipts (generateEngineerReceiptPdf, used by the Excel bulk
// upload and by POST /receipt/render for the portal's receipt screens).
// Change the design here and it changes everywhere.
//
// Receipt numbers: ERB/RCT/<year>/<serial>, one series for all receipts,
// held in erb_receipt_numbers so the same payment always keeps the same
// number (re-downloads, resends and regenerated PDFs included).

import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { DataTypes } from 'sequelize'
import { sequelize } from '../config/database.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.resolve(__dirname, '../assets')
const LOGO_PATH = [path.join(ASSETS, 'approval-letter', 'erb-logo.png'), path.join(ASSETS, 'erb-logo.png')]
  .find(p => fs.existsSync(p)) || null

// ── Goudy: licensed Goudy Old Style if installed, else Sorts Mill Goudy ──
// Same lookup as utils/approval-letter.js, so letters and receipts match.
const FONT_DIRS = [process.env.ERB_LETTER_FONT_DIR, path.join(ASSETS, 'fonts')].filter(Boolean)
const findFont = (...names) => {
  for (const dir of FONT_DIRS) for (const n of names) {
    const p = path.join(dir, n)
    if (fs.existsSync(p)) return p
  }
  return null
}
const LICENSED = { regular: findFont('GOUDOS.TTF', 'GoudyOldStyle-Regular.ttf'), bold: findFont('GOUDOSB.TTF', 'GoudyOldStyle-Bold.ttf'), italic: findFont('GOUDOSI.TTF', 'GoudyOldStyle-Italic.ttf') }
const OPEN     = { regular: findFont('SortsMillGoudy-Regular.ttf'), bold: null, italic: findFont('SortsMillGoudy-Italic.ttf') }
const FONTS    = LICENSED.regular ? LICENSED : OPEN.regular ? OPEN : null

const K = '#000000'
const WHITE = '#ffffff'

// ── Receipt number series ─────────────────────────────────────────
const ReceiptNumber = sequelize.define('ReceiptNumber', {
  id:         { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  // What the number belongs to, e.g. "TX:MTN-1234", "LICENCE:5512", "WED:88".
  source_key: { type: DataTypes.STRING(191), allowNull: false, unique: true },
  receipt_no: { type: DataTypes.STRING(40) },
  issued_at:  { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'erb_receipt_numbers', timestamps: false })

const ready = ReceiptNumber.sync().catch(err => console.error('[standard-receipt] erb_receipt_numbers sync error:', err.message))

/**
 * The receipt number for a payment — created on first use, then stable.
 * @returns {Promise<{ receiptNo: string, issuedAt: Date }>}
 */
export async function assignReceiptNumber(sourceKey) {
  await ready
  const key = String(sourceKey).slice(0, 191)
  let row = await ReceiptNumber.findOne({ where: { source_key: key } })
  if (!row) {
    try {
      row = await ReceiptNumber.create({ source_key: key, issued_at: new Date() })
    } catch (err) {
      // Created at the same moment by another request — use that one.
      row = await ReceiptNumber.findOne({ where: { source_key: key } })
      if (!row) throw err
    }
  }
  if (!row.receipt_no) {
    const year = new Date(row.issued_at).getFullYear()
    row.receipt_no = `ERB/RCT/${year}/${String(row.id).padStart(6, '0')}`
    await row.save()
  }
  return { receiptNo: row.receipt_no, issuedAt: row.issued_at }
}

// ── Helpers ────────────────────────────────────────────────────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
function below1000(n) {
  const h = Math.floor(n / 100), r = n % 100, out = []
  if (h) out.push(`${ONES[h]} Hundred`)
  if (r) out.push(r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? '-' + ONES[r % 10] : ''}`)
  return out.join(' and ')
}
/** 750000 → "Seven Hundred and Fifty Thousand" */
export function amountInWords(amount) {
  let n = Math.round(Number(amount) || 0)
  if (!n) return 'Zero'
  const out = []
  for (const [v, name] of [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']]) {
    if (n >= v) { out.push(`${below1000(Math.floor(n / v))} ${name}`); n %= v }
  }
  if (n) out.push((out.length && n < 100 ? 'and ' : '') + below1000(n))
  return out.join(' ')
}
const money = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }))
const fmtDate = (d) => {
  if (!d) return null
  const x = new Date(d)
  return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' })
}
const present = (v) => v != null && String(v).trim() !== '' && String(v) !== 'null' && String(v) !== 'undefined'

/**
 * Draws one standard receipt to `filePath`.
 *
 * @param {object} r
 *   receiptNo, issuedOn            — top-right box
 *   typeLabel                      — subtitle under PAYMENT RECEIPT
 *   status                         — 'PAID' (default) or e.g. 'PREVIEW'
 *   name, regNo, licenceNo, appNo, specialization, email   — Received from
 *   method, reference, paidOn      — Payment details
 *   items: [{ description, period, amount }]
 *   issuedBy                       — signature line ("ERB System", "ERB Accounts", a staff name)
 * @returns {Promise<string>} filePath
 */
export function renderStandardReceipt(r, filePath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, left: 54, right: 54, bottom: 40 },
        info: { Title: `ERB Receipt ${r.receiptNo || ''}`.trim(), Author: 'Engineers Registration Board' },
      })
      const stream = fs.createWriteStream(filePath)
      doc.pipe(stream)

      if (FONTS) {
        doc.registerFont('G', FONTS.regular)
        doc.registerFont('GI', FONTS.italic || FONTS.regular)
        if (FONTS.bold) doc.registerFont('GB', FONTS.bold)
      }
      // Text with Goudy (lining figures). Without a bold cut, bold is a
      // thin stroke over the fill — same technique as the approval letter.
      const t = (txt, x, y, o = {}, { bold = false, italic = false, size = 11, color = K } = {}) => {
        let font, faux = false
        if (!FONTS) font = bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : italic ? 'Times-Italic' : 'Times-Roman'
        else if (italic) { font = 'GI'; faux = bold }
        else if (bold && FONTS.bold) font = 'GB'
        else { font = 'G'; faux = bold }
        doc.font(font).fontSize(size).fillColor(color).strokeColor(color)
        if (faux) doc.lineWidth(Math.max(0.4, size * 0.035))
        return doc.text(String(txt ?? ''), x, y, { features: FONTS ? ['lnum'] : [], ...o, fill: true, stroke: faux })
      }

      const W = doc.page.width, L = 54, R = W - 54, CW = R - L
      const items = (r.items && r.items.length ? r.items : [{ description: r.typeLabel || 'Payment', period: '', amount: r.amount }])
        .map(i => ({ ...i, amount: Number(i.amount) || 0 }))
      const total = items.reduce((s, i) => s + i.amount, 0)

      // ── Centred letterhead (logo is the only colour on the page) ──
      let y = 38
      const logo = 70
      if (LOGO_PATH) {
        try { doc.image(LOGO_PATH, (W - logo) / 2, y, { width: logo, height: logo }) } catch { /* bad image — skip */ }
      }
      y += logo + 8
      t('ENGINEERS REGISTRATION BOARD', L, y, { width: CW, align: 'center', characterSpacing: 2.2 }, { bold: true, size: 16 })
      y += 21
      t('For Engineering Excellence', L, y, { width: CW, align: 'center' }, { italic: true, size: 10 })
      y += 15
      t('P.O. Box 29267, Kampala, Uganda   ·   Tel: +256 39 3194942   ·   info@erb.go.ug   ·   www.erb.go.ug',
        L, y, { width: CW, align: 'center' }, { size: 9.5 })
      y += 20
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.6).strokeColor(K).stroke()
      doc.moveTo(L, y + 3).lineTo(R, y + 3).lineWidth(2).stroke()

      // ── Title + receipt box ──
      y += 22
      t('PAYMENT RECEIPT', L, y + 4, { lineBreak: false, characterSpacing: 1.5 }, { bold: true, size: 22 })
      if (present(r.typeLabel)) t(r.typeLabel, L, y + 34, { width: CW - 240 }, { italic: true, size: 12 })

      const bw = 210, bx = R - bw, rowH = 20, splitX = 84
      const status = r.status || 'PAID'
      const box = [['Receipt No.', r.receiptNo || '—'], ['Date issued', fmtDate(r.issuedOn || new Date())], ['Status', status]]
      doc.rect(bx, y, bw, rowH * box.length).lineWidth(1).strokeColor(K).stroke()
      box.forEach(([k, v], i) => {
        const ry = y + i * rowH
        if (i) doc.moveTo(bx, ry).lineTo(R, ry).lineWidth(0.5).strokeColor(K).stroke()
        const dark = k === 'Status'
        if (dark) doc.rect(bx + splitX, ry, bw - splitX, rowH).fill(K)
        t(k, bx + 8, ry + 5, { lineBreak: false }, { size: 10 })
        t(v, bx + splitX + 6, ry + 5, { width: bw - splitX - 14, align: 'right', lineBreak: false, characterSpacing: dark ? 3 : 0 },
          { bold: true, size: 10.5, color: dark ? WHITE : K })
      })
      doc.moveTo(bx + splitX, y).lineTo(bx + splitX, y + rowH * box.length).lineWidth(0.5).strokeColor(K).stroke()

      // ── Received from | Payment details ──
      y += rowH * box.length + 26
      const colW = (CW - 24) / 2
      const panel = (title, x, rows) => {
        t(title.toUpperCase(), x, y, { lineBreak: false, characterSpacing: 1.2 }, { bold: true, size: 9.5 })
        doc.moveTo(x, y + 14).lineTo(x + colW, y + 14).lineWidth(0.8).strokeColor(K).stroke()
        let yy = y + 22
        rows.filter(([, v]) => present(v)).forEach(([k, v]) => {
          t(k, x, yy, { width: 105, lineBreak: false }, { size: 10.5 })
          t(String(v), x + 105, yy, { width: colW - 105 }, { bold: true, size: 10.5 })
          yy = doc.y + 5
        })
        return yy
      }
      const yA = panel('Received from', L, [
        ['Name', r.name], ['Registration No.', r.regNo], ['Licence No.', r.licenceNo],
        ['Application No.', r.appNo], ['Specialisation', r.specialization], ['Email', r.email],
      ])
      const payRows = [['Method', r.method], ['Reference', r.reference], ['Date paid', fmtDate(r.paidOn)]]
      const yB = panel('Payment details', L + colW + 24,
        payRows.some(([, v]) => present(v)) ? payRows : [['Recorded', fmtDate(r.issuedOn || new Date())]])
      y = Math.max(yA, yB) + 18

      // ── Item table ──
      const cols = [
        { h: 'No.', w: 34, a: 'center' },
        { h: 'Description', w: CW - 34 - 90 - 120, a: 'left' },
        { h: 'Period', w: 90, a: 'center' },
        { h: 'Amount (UGX)', w: 120, a: 'right' },
      ]
      const th = 24
      doc.rect(L, y, CW, th).fill(K)
      let x = L
      cols.forEach(c => { t(c.h, x + 8, y + 7, { width: c.w - 16, align: c.a, lineBreak: false }, { bold: true, size: 10, color: WHITE }); x += c.w })
      y += th
      items.forEach((it, idx) => {
        const cells = [idx + 1, it.description || '—', present(it.period) ? it.period : '—', money(it.amount)]
        doc.font(FONTS ? 'G' : 'Times-Roman').fontSize(11.5)
        const textH = Math.max(...cells.map((v, i) => doc.heightOfString(String(v), { width: cols[i].w - 16 })))
        const rh = Math.max(34, textH + 20)
        x = L
        cells.forEach((v, i) => { t(v, x + 8, y + 10, { width: cols[i].w - 16, align: cols[i].a }, { size: 11.5 }); x += cols[i].w })
        doc.moveTo(L, y + rh).lineTo(R, y + rh).lineWidth(0.5).strokeColor(K).stroke()
        y += rh
      })

      // ── Totals + amount in words ──
      const tw = 210, tx = R - tw
      y += 6
      t('Sub-total', tx + 8, y + 6, { lineBreak: false }, { size: 11 })
      t(money(total), tx, y + 6, { width: tw - 8, align: 'right', lineBreak: false }, { size: 11 })
      y += 24
      t('Amount in words', L, y - 18, { lineBreak: false }, { size: 10 })
      t(`${amountInWords(total)} Uganda Shillings Only`, L, y - 3, { width: CW - tw - 24 }, { italic: true, bold: true, size: 11.5 })
      const wordsEnd = doc.y
      doc.rect(tx, y, tw, 30).lineWidth(1.6).strokeColor(K).stroke()
      t('TOTAL PAID', tx + 8, y + 9, { lineBreak: false, characterSpacing: 1 }, { bold: true, size: 11 })
      t(`UGX ${money(total)}`, tx, y + 7, { width: tw - 8, align: 'right', lineBreak: false }, { bold: true, size: 14 })

      // ── Thanks + issued by ──
      y = Math.max(y + 62, wordsEnd + 24)
      t('Received with thanks.', L, y, {}, { italic: true, size: 12 })
      t('Please keep this receipt for your records; it may be requested as proof of payment.', L, y + 18, { width: CW }, { size: 10.5 })
      y += 64
      doc.moveTo(R - 200, y).lineTo(R, y).lineWidth(0.6).strokeColor(K).stroke()
      t(r.issuedBy || 'ERB System', R - 200, y + 6, { width: 200, align: 'center' }, { bold: true, size: 10.5 })
      t('Issued by', R - 200, y + 20, { width: 200, align: 'center' }, { size: 9.5 })

      // ── Footer ──
      const fy = doc.page.height - 40 - 34
      doc.moveTo(L, fy).lineTo(R, fy).lineWidth(0.6).strokeColor(K).stroke()
      t(`${r.receiptNo || ''}${r.receiptNo ? '   ·   ' : ''}This is a computer-generated receipt and is valid without a signature.`,
        L, fy + 8, { width: CW, align: 'center', lineBreak: false }, { size: 9 })
      t('To verify, email info@erb.go.ug quoting the receipt number.', L, fy + 21, { width: CW, align: 'center', lineBreak: false }, { italic: true, size: 9 })

      doc.end()
      stream.on('finish', () => resolve(filePath))
      stream.on('error', reject)
    } catch (err) {
      reject(err)
    }
  })
}
