// ── Bulk invoice upload: parsing + validation ──────────────────────
// Pure functions (no DB access) so they can be unit-tested and reused
// by both /bulk/validate and /bulk/commit. DB-dependent checks
// (invoice_no already used, engineer already invoiced for the FY) are
// layered on top in routes/invoice_routes.js.
import XLSX from 'xlsx'

export const MAX_BULK_ROWS = 1000

// ── Invoice types ──────────────────────────────────────────────────
// ANNUAL    → existing annual-fees invoices (Invoice Records)
// TEMPORARY → Temporary Engineer's registration, licence & stamp renewal
//             invoices (Temporary Invoice Records). Same table, endpoints,
//             queue and worker — only the template, defaults and the
//             "year" rule differ. For TEMPORARY, financial_year holds the
//             renewal year ("2027") rather than a "2026/2027" FY.
export const INVOICE_TYPES = ['ANNUAL', 'TEMPORARY']
export const normaliseInvoiceType = (v) =>
  String(v || '').trim().toUpperCase() === 'TEMPORARY' ? 'TEMPORARY' : 'ANNUAL'

// Canonical columns, in template order.
export const TEMPLATE_COLUMNS = [
  { key: 'engineer_name',        label: 'engineer_name',        required: true,  example: 'Eng. John Doe' },
  { key: 'erb_no',               label: 'erb_no',               required: true,  example: '1017' },
  { key: 'email',                label: 'email',                required: true,  example: 'john.doe@example.com' },
  { key: 'address',              label: 'address',              required: false, example: 'P.O Box 1234, Kampala' },
  { key: 'annual_fee_engineers', label: 'annual_fee_engineers', required: false, example: 1 },
  { key: 'annual_fee_rate',      label: 'annual_fee_rate',      required: false, example: 600000 },
  { key: 'arrears_amount',       label: 'arrears_amount',       required: false, example: 600000 },
  { key: 'surcharge_percent',    label: 'surcharge_percent',    required: false, example: 25 },
  { key: 'financial_year',       label: 'financial_year',       required: false, example: '2026/2027' },
  { key: 'arrears_year',         label: 'arrears_year',         required: false, example: '2025/2026' },
  { key: 'invoice_date',         label: 'invoice_date',         required: false, example: '2026-09-28' },
  { key: 'invoice_no',           label: 'invoice_no',           required: false, example: '' },
]

// Temporary engineers: one line item (registration, licence & stamp
// renewal for the renewal year) plus any arrears. No surcharge is billed —
// the 50% late-payment surcharge is only a note on the invoice.
export const TEMPORARY_TEMPLATE_COLUMNS = [
  { key: 'engineer_name',   label: 'engineer_name',   required: true,  example: 'Eng. Huang Mengxin' },
  { key: 'erb_no',          label: 'erb_no',          required: true,  example: 'TR 245' },
  { key: 'email',           label: 'email',           required: true,  example: 'huang.mengxin@example.com' },
  { key: 'address',         label: 'address',         required: false, example: 'P.O Box 1234, Kampala' },
  { key: 'annual_fee_rate', label: 'renewal_fee',     required: false, example: 1800000 },
  { key: 'arrears_amount',  label: 'arrears_amount',  required: false, example: 0 },
  { key: 'financial_year',  label: 'renewal_year',    required: false, example: '2027' },
  { key: 'invoice_date',    label: 'invoice_date',    required: false, example: '2026-10-01' },
  { key: 'invoice_no',      label: 'invoice_no',      required: false, example: '' },
]

export const templateColumnsFor = (type) =>
  normaliseInvoiceType(type) === 'TEMPORARY' ? TEMPORARY_TEMPLATE_COLUMNS : TEMPLATE_COLUMNS

// Header aliases → canonical key. Headers are normalised first
// (lower-case, non-alphanumerics collapsed to "_"), so "ERB No.",
// "erb no" and "ERB_NO" all become "erb_no".
const HEADER_ALIASES = {
  engineer_name: ['engineer_name', 'name', 'engineer', 'name_of_the_engineer', 'name_of_engineer', 'full_name', 'engineer_s_name'],
  erb_no:        ['erb_no', 'erb_number', 'reg_no', 'registration_no', 'registration_number', 'reg_number', 'erb_reg_no'],
  email:         ['email', 'email_address', 'e_mail', 'engineer_s_email', 'engineer_email', 'emails'],
  address:       ['address', 'postal_address', 'box'],
  annual_fee_engineers: ['annual_fee_engineers', 'no_of_engineers', 'number_of_engineers', 'engineers'],
  annual_fee_rate:      ['annual_fee_rate', 'rate', 'annual_fee', 'annual_fees', 'fee_rate', 'renewal_fee', 'renewal_rate'],
  arrears_amount:       ['arrears_amount', 'arrears', 'arrears_ugx'],
  surcharge_percent:    ['surcharge_percent', 'surcharge', 'surcharge_pct', 'surcharge_rate'],
  financial_year:       ['financial_year', 'fy', 'billing_year', 'financial_year_billing', 'renewal_year', 'year'],
  arrears_year:         ['arrears_year', 'arrears_fy'],
  invoice_date:         ['invoice_date', 'date'],
  invoice_no:           ['invoice_no', 'invoice_number', 'invoice'],
}

const ALIAS_LOOKUP = Object.entries(HEADER_ALIASES).reduce((acc, [key, list]) => {
  list.forEach(a => { acc[a] = key })
  return acc
}, {})

export const normaliseHeader = (h) =>
  String(h ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const FY_RE    = /^(\d{4})\s*[/\-]\s*(\d{4})$/
const YEAR_RE  = /^(\d{4})(?:\.0+)?$/

const isBlank = (v) => v === undefined || v === null || String(v).trim() === ''

// "600,000", "UGX 600000", " 600000.00 " → 600000
const parseNumber = (v) => {
  if (typeof v === 'number') return v
  const cleaned = String(v).replace(/ugx|shs?|,|\s/gi, '')
  if (cleaned === '') return NaN
  return Number(cleaned)
}

const pad = (n) => String(n).padStart(2, '0')
const toISODate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// Accepts JS Date (xlsx cellDates), Excel serial, YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY.
const parseDate = (v) => {
  if (v instanceof Date && !isNaN(v)) return toISODate(v)
  if (typeof v === 'number') {
    const p = XLSX.SSF.parse_date_code(v)
    if (p) return `${p.y}-${pad(p.m)}-${pad(p.d)}`
    return null
  }
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return validYMD(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/)
  if (m) return validYMD(+m[3], +m[2], +m[1]) // ERB convention: day first
  return null
}

const validYMD = (y, mo, d) => {
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${pad(mo)}-${pad(d)}`
}

const normaliseFY = (v) => {
  const m = String(v).trim().match(FY_RE)
  if (!m) return { value: String(v).trim(), ok: false }
  const ok = Number(m[2]) === Number(m[1]) + 1
  return { value: `${m[1]}/${m[2]}`, ok }
}

// Mirrors computeTotals() in invoice_routes.js and computeInvoiceTotals() in the frontend.
export const computeTotals = (d) => {
  const annual_fee_amount = (Number(d.annual_fee_engineers) || 0) * (Number(d.annual_fee_rate) || 0)
  const surcharge_amount  = Math.round((Number(d.arrears_amount) || 0) * ((Number(d.surcharge_percent) || 0) / 100))
  const total_amount      = annual_fee_amount + (Number(d.arrears_amount) || 0) + surcharge_amount
  return { annual_fee_amount, surcharge_amount, total_amount }
}

// ── Parse an uploaded buffer (.csv / .xlsx / .xls) into raw row objects ──
export function parseSpreadsheet(buffer, originalName = '') {
  const isCsv = /\.csv$/i.test(originalName)
  const wb = isCsv
    ? XLSX.read(buffer.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string', raw: true }) // raw: keep ERB nos like "0017" as text
    : XLSX.read(buffer, { type: 'buffer' }) // dates stay Excel serials → timezone-safe parse

  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('The file has no sheets')
  const sheet = wb.Sheets[sheetName]

  // header:1 → array of arrays so we can map headers ourselves
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true, raw: true })
  if (!matrix.length) throw new Error('The file is empty')

  const rawHeaders = matrix[0]
  const headerMap = rawHeaders.map(h => ALIAS_LOOKUP[normaliseHeader(h)] || null)
  const unknownHeaders = rawHeaders.filter((h, i) => !headerMap[i] && !isBlank(h)).map(String)

  const missingRequired = TEMPLATE_COLUMNS
    .filter(c => c.required && !headerMap.includes(c.key))
    .map(c => c.key)

  const rows = []
  for (let r = 1; r < matrix.length; r++) {
    const line = matrix[r]
    if (!line || line.every(isBlank)) continue
    const obj = {}
    headerMap.forEach((key, i) => {
      if (key && isBlank(obj[key])) obj[key] = line[i]
    })
    rows.push({ row: r + 1, raw: obj }) // spreadsheet row number (1-based, header = 1)
  }

  return { rows, unknownHeaders, missingRequired, sheetName }
}

// ── Batch-level defaults for blank cells ───────────────────────────
// Temporary engineers: 2027 renewal at UGX 1,800,000, no surcharge billed.
export const defaultTemporaryBatchSettings = () => ({
  invoice_date:         toISODate(new Date()),
  financial_year:       '2027',
  arrears_year:         '',
  annual_fee_engineers: 1,
  annual_fee_rate:      1800000,
  arrears_amount:       0,
  surcharge_percent:    0,
  invoice_prefix:       'ERB/TEMP/INV/2027/',
})

export const defaultBatchSettingsFor = (type) =>
  normaliseInvoiceType(type) === 'TEMPORARY' ? defaultTemporaryBatchSettings() : defaultBatchSettings()

export const defaultBatchSettings = () => ({
  invoice_date:         toISODate(new Date()),
  financial_year:       '2026/2027',
  arrears_year:         '2025/2026',
  annual_fee_engineers: 1,
  annual_fee_rate:      600000,
  arrears_amount:       0,
  surcharge_percent:    25,
  invoice_prefix:       `ERB/INV/${new Date().getFullYear()}/`,
})

export const newBatchId = () =>
  `B${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`

// ── Validate + normalise one row ───────────────────────────────────
export function validateRow(raw, defaults, { autoInvoiceNo, invoiceType = 'ANNUAL' } = {}) {
  const isTemporary = normaliseInvoiceType(invoiceType) === 'TEMPORARY'
  const errors = []
  const warnings = []
  const pick = (k) => (isBlank(raw[k]) ? defaults[k] : raw[k])

  const data = {}

  // Text fields
  data.engineer_name = String(raw.engineer_name ?? '').trim().replace(/\s+/g, ' ')
  if (!data.engineer_name) errors.push('Engineer name is required')
  else if (!/^eng\.?\s/i.test(data.engineer_name)) data.engineer_name = `Eng. ${data.engineer_name}`

  data.erb_no = String(raw.erb_no ?? '').trim()
  if (/^\d+\.0+$/.test(data.erb_no)) data.erb_no = data.erb_no.replace(/\.0+$/, '') // Excel numeric
  if (!data.erb_no) errors.push('ERB No. is required')

  data.address = String(raw.address ?? '').trim()
  if (!data.address) warnings.push('Address is blank — invoice will show no address')

  // Email: allow several separated by ; or , (the engineers DB stores "a@x;b@y")
  const emails = String(raw.email ?? '')
    .split(/[;,\s]+/).map(e => e.trim().toLowerCase()).filter(Boolean)
  if (!emails.length) errors.push('Email is required to send the invoice')
  const badEmails = emails.filter(e => !EMAIL_RE.test(e))
  if (badEmails.length) errors.push(`Invalid email: ${badEmails.join(', ')}`)
  data.email = [...new Set(emails)].join(', ')
  if (emails.some(e => /@example\.(com|org)$/.test(e))) errors.push('Looks like the template example row — delete it or use a real email')
  if (data.email.length > 255) errors.push('Email list is too long (max 255 characters)')

  // Numbers
  const num = (key, label, { integer = false, min = 0, max = Infinity } = {}) => {
    const v = pick(key)
    const n = parseNumber(v)
    if (isBlank(v) || Number.isNaN(n)) { errors.push(`${label} must be a number`); return 0 }
    if (integer && !Number.isInteger(n)) errors.push(`${label} must be a whole number`)
    if (n < min) errors.push(`${label} cannot be less than ${min}`)
    if (n > max) errors.push(`${label} cannot be more than ${max}`)
    return n
  }
  data.annual_fee_engineers = num('annual_fee_engineers', 'No. of engineers', { integer: true, min: 1, max: 10000 })
  data.annual_fee_rate      = num('annual_fee_rate', 'Annual fee rate', { min: 0, max: 1e11 })
  data.arrears_amount       = num('arrears_amount', 'Arrears amount', { min: 0, max: 1e11 })
  data.surcharge_percent    = num('surcharge_percent', 'Surcharge %', { min: 0, max: 100 })

  // Years
  if (isTemporary) {
    // Renewal year, e.g. 2027
    const yv = String(pick('financial_year') ?? '').trim()
    const ym = yv.match(YEAR_RE)
    data.financial_year = ym ? ym[1] : yv
    if (!ym || +ym[1] < 2000 || +ym[1] > 2100) errors.push(`Renewal year "${yv}" must be a year like 2027`)
    data.arrears_year = String(pick('arrears_year') ?? '').trim() || null
    // Temporary invoices bill a single engineer and no surcharge.
    data.annual_fee_engineers = 1
    data.surcharge_percent    = 0
  } else {
    const fy = normaliseFY(pick('financial_year'))
    data.financial_year = fy.value
    if (!fy.ok) errors.push(`Financial year "${fy.value}" must look like 2026/2027`)

    const ay = normaliseFY(pick('arrears_year'))
    data.arrears_year = ay.value
    if (!ay.ok) errors.push(`Arrears year "${ay.value}" must look like 2025/2026`)
  }

  // Date
  const dateVal = pick('invoice_date')
  data.invoice_date = parseDate(dateVal)
  if (!data.invoice_date) errors.push(`Invoice date "${dateVal}" is not a valid date (use YYYY-MM-DD or DD/MM/YYYY)`)

  // Invoice number
  data.invoice_no = String(raw.invoice_no ?? '').trim()
  if (!data.invoice_no && autoInvoiceNo) data.invoice_no = autoInvoiceNo
  if (!data.invoice_no) errors.push('Invoice number is required')
  if (data.invoice_no.length > 100) errors.push('Invoice number is too long (max 100 characters)')

  data.invoice_type = isTemporary ? 'TEMPORARY' : 'ANNUAL'

  const totals = computeTotals(data)
  Object.assign(data, totals)
  if (totals.total_amount <= 0) errors.push('Invoice total is 0 — check the rate / arrears figures')

  return { data, errors, warnings }
}

// ── Validate a whole batch (no DB) ─────────────────────────────────
// rows: [{ row, raw }]. Adds cross-row duplicate checks.
export function validateBatch(rows, settings, batchId, invoiceType = 'ANNUAL') {
  const type = normaliseInvoiceType(invoiceType)
  const base = defaultBatchSettingsFor(type)
  const defaults = { ...base, ...settings }
  const prefix = String(defaults.invoice_prefix || '').trim() || base.invoice_prefix
  const batchTag = String(batchId).slice(-6)

  const results = rows.map(({ row, raw }, i) => {
    const autoInvoiceNo = `${prefix}${batchTag}-${String(i + 1).padStart(4, '0')}`
    return { row, ...validateRow(raw, defaults, { autoInvoiceNo, invoiceType: type }) }
  })

  // In-file duplicates
  const seenInvoice = new Map()
  const seenEngineerFY = new Map()
  for (const r of results) {
    const inv = r.data.invoice_no.toUpperCase()
    if (inv) {
      if (seenInvoice.has(inv)) r.errors.push(`Duplicate invoice number (also on row ${seenInvoice.get(inv)})`)
      else seenInvoice.set(inv, r.row)
    }
    const key = `${r.data.erb_no}|${r.data.financial_year}`.toUpperCase()
    if (r.data.erb_no) {
      if (seenEngineerFY.has(key)) r.errors.push(`ERB No. ${r.data.erb_no} appears twice for ${type === 'TEMPORARY' ? 'renewal year' : 'FY'} ${r.data.financial_year} (also row ${seenEngineerFY.get(key)})`)
      else seenEngineerFY.set(key, r.row)
    }
  }
  return results
}

// ── Template workbook / CSV ────────────────────────────────────────
export function buildTemplate(format = 'xlsx', invoiceType = 'ANNUAL') {
  const isTemporary = normaliseInvoiceType(invoiceType) === 'TEMPORARY'
  const columns = templateColumnsFor(invoiceType)
  const headers = columns.map(c => c.label)
  const example = columns.map(c => c.example)
  const ws = XLSX.utils.aoa_to_sheet([headers, example])
  ws['!cols'] = columns.map(c => ({ wch: Math.max(c.label.length + 2, 18) }))

  if (format === 'csv') {
    return { buffer: Buffer.from('\uFEFF' + XLSX.utils.sheet_to_csv(ws), 'utf8'), mime: 'text/csv', ext: 'csv' }
  }

  const notes = XLSX.utils.aoa_to_sheet(isTemporary ? [
    ['Column', 'Required', 'Notes'],
    ['engineer_name', 'Yes', '"Eng." is added automatically if missing'],
    ['erb_no', 'Yes', 'Temporary registration number, e.g. TR 245'],
    ['email', 'Yes', 'Several addresses allowed, separated by ; or ,'],
    ['address', 'No', 'Printed under the engineer name'],
    ['renewal_fee', 'No', 'UGX. Registration, licence & stamp renewal. Blank = 1,800,000'],
    ['arrears_amount', 'No', 'UGX. Blank = 0'],
    ['renewal_year', 'No', 'e.g. 2027. Blank = batch default'],
    ['invoice_date', 'No', 'YYYY-MM-DD or DD/MM/YYYY. Blank = batch default'],
    ['invoice_no', 'No', 'Leave blank to auto-generate a unique number'],
    [],
    ['Delete the example row before uploading. Only the first sheet is read.'],
  ] : [
    ['Column', 'Required', 'Notes'],
    ['engineer_name', 'Yes', '"Eng." is added automatically if missing'],
    ['erb_no', 'Yes', 'ERB registration number'],
    ['email', 'Yes', 'Several addresses allowed, separated by ; or ,'],
    ['address', 'No', 'Printed under the engineer name'],
    ['annual_fee_engineers', 'No', 'Blank = batch default (1)'],
    ['annual_fee_rate', 'No', 'UGX. Blank = batch default'],
    ['arrears_amount', 'No', 'UGX. Blank = batch default (0)'],
    ['surcharge_percent', 'No', 'Applied to arrears. Blank = batch default'],
    ['financial_year', 'No', 'Format 2026/2027. Blank = batch default'],
    ['arrears_year', 'No', 'Format 2025/2026. Blank = batch default'],
    ['invoice_date', 'No', 'YYYY-MM-DD or DD/MM/YYYY. Blank = batch default'],
    ['invoice_no', 'No', 'Leave blank to auto-generate a unique number'],
    [],
    ['Delete the example row before uploading. Only the first sheet is read.'],
  ])
  notes['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 60 }]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Invoices')
  XLSX.utils.book_append_sheet(wb, notes, 'Instructions')
  return {
    buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  }
}
