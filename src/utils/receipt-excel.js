import XLSX from 'xlsx'

// ── Header aliasing ──────────────────────────────────────────────
// Admins won't always type column headers exactly the same way, so
// match loosely: lowercase, strip everything but letters/digits, then
// look up against known aliases for each canonical field.
const normalizeKey = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '')

const FIELD_ALIASES = {
  name: ['name', 'enginername', 'enginner', 'enginee', 'fullname', 'engineername'],
  reg_no: ['regno', 'registrationno', 'registrationnumber', 'regnumber', 'regnum'],
  email: ['email', 'emailaddress', 'mail'],
  specialization: ['specialization', 'specialisation', 'field', 'discipline'],
  amount_paid: ['amount', 'amountpaid', 'amountugx', 'amountpaidugx', 'fee', 'feeamount'],
  purpose: ['purpose', 'reason'],
}

const REQUIRED_FIELDS = ['name', 'reg_no', 'email', 'specialization', 'amount_paid']

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const findCanonicalKey = (rawKey) => {
  const norm = normalizeKey(rawKey)
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.includes(norm)) return canonical
  }
  return null
}

const cleanAmount = (value) => {
  if (value == null || value === '') return null
  const num = Number(String(value).replace(/[, ]/g, ''))
  return Number.isFinite(num) ? num : null
}

/**
 * Reads an uploaded workbook and returns normalized, per-row-validated data.
 *
 * @param {string} filePath path to the uploaded .xlsx/.xls file
 * @returns {{ rows: object[], errors: object[] }}
 *   rows   — every row that had at least some data, normalized to
 *            { name, reg_no, email, specialization, amount_paid, purpose, _rowNumber }
 *   errors — { row, name, reg_no, errors: string[] } for rows that failed
 *            structural validation (missing fields, bad email, bad amount,
 *            or a reg_no repeated elsewhere in the same file)
 */
export function parseReceiptWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath)
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) return { rows: [], errors: [{ row: 0, errors: ['The uploaded file has no readable sheet'] }] }

  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' })

  const rows = rawRows.map((raw, idx) => {
    const row = { _rowNumber: idx + 2 } // +2: header row is row 1, data starts at row 2
    for (const [rawKey, value] of Object.entries(raw)) {
      const canonical = findCanonicalKey(rawKey)
      if (!canonical) continue
      row[canonical] = typeof value === 'string' ? value.trim() : value
    }
    row.amount_paid = cleanAmount(row.amount_paid)
    return row
  }).filter(row => Object.keys(row).some(k => k !== '_rowNumber' && row[k] !== '' && row[k] != null))

  const errors = []
  const seenRegNos = new Map() // reg_no -> first row number seen at

  for (const row of rows) {
    const rowErrors = []

    for (const field of REQUIRED_FIELDS) {
      if (row[field] === undefined || row[field] === null || row[field] === '') {
        rowErrors.push(`Missing ${field.replace('_', ' ')}`)
      }
    }
    if (row.email && !EMAIL_RE.test(row.email)) {
      rowErrors.push(`Invalid email address: ${row.email}`)
    }
    if (row.amount_paid != null && row.amount_paid <= 0) {
      rowErrors.push('Amount must be greater than zero')
    }

    if (row.reg_no) {
      const key = String(row.reg_no).trim()
      if (seenRegNos.has(key)) {
        rowErrors.push(`Duplicate registration number in this file (also on row ${seenRegNos.get(key)})`)
      } else {
        seenRegNos.set(key, row._rowNumber)
      }
    }

    if (rowErrors.length) {
      errors.push({ row: row._rowNumber, name: row.name || '-', reg_no: row.reg_no || '-', errors: rowErrors })
    }
  }

  return { rows, errors }
}
