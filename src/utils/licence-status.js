// ── Licence status per year for a registered engineer ─────────────
// Answers "does this engineer already hold / have paid for a licence for
// year Y?" from the two places that record it:
//
//   1. data.erb.go.ug paid-records  — the issued-licence register
//      (reg_no + year_paid, license_no "<reg>/<year>"). A hit here means
//      the licence for that year exists, however it was paid.
//   2. payment_transactions (purpose RENEWAL) — renewals paid through
//      this portal, keyed by renewal_year. Rows created before
//      renewal_year existed fall back to the year they were created.
//
// Used by GET /api/erb/receipt/licence-status (engineer dashboard and
// renewal page) and to block paying twice for the same year.
import { Op } from 'sequelize'
import { PaymentTransaction } from '../controllers/receipt-controller.js'

const DATA_API_BASE = 'https://data.erb.go.ug/api/engineers'
// paid-records only supports a fuzzy ?search and a fixed page size of 10,
// so walk pages and exact-match on reg_no (same approach as the bulk
// receipt duplicate check in receipt_routes.js).
const MAX_PAGES = 20

export const currentYear = () => new Date().getFullYear()

// Years an engineer may pay a renewal for: this year and next year.
export const allowedRenewalYears = () => [currentYear(), currentYear() + 1]

export function parseRenewalYear(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const y = parseInt(value, 10)
  return allowedRenewalYears().includes(y) ? y : NaN
}

// Strip a licence-year suffix ("1540/2026" → "1540") — only when a digit
// precedes the slash, so "TR/0289" isn't mistaken for "TR" + year 0289.
const normReg = (v) => String(v ?? '').trim().replace(/(\d)\s*\/\s*(19|20)\d{2}$/, '$1').toUpperCase()

// Registration numbers aren't stored consistently in the licence
// register: "TR289", "TR 289", "TR/289", "TR-289", or just "289" with
// base_field = TEMPORARY. Compare on a compact form (letters + digits,
// leading zeros dropped) and treat a bare number on a TEMPORARY row as
// the same engineer as "TR<number>".
const compactReg = (v) => normReg(v).replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]*)0+(\d)/, '$1$2')
const regDigits  = (v) => (compactReg(v).match(/\d+/) || [''])[0]
const regPrefix  = (v) => (compactReg(v).match(/^[A-Z]+/) || [''])[0]
const isTempRow  = (r) => /TEMP/i.test(String(r?.base_field || r?.type || ''))

function sameEngineer(r, target, email) {
  const rowReg = compactReg(r.reg_no || String(r.license_no || '').split('/')[0])
  // A bare "289" on a TEMPORARY row is TR289's — never permanent 289's.
  if (rowReg && rowReg === target) return !(isTempRow(r) && !regPrefix(target) && !regPrefix(rowReg))
  // "289" on a TEMPORARY row  ⇔  "TR289"
  if (rowReg && regDigits(rowReg) === regDigits(target) && regDigits(target)) {
    const rp = regPrefix(rowReg), tp = regPrefix(target)
    if (!rp && tp === 'TR' && isTempRow(r)) return true
    if (rp === 'TR' && !tp && isTempRow(r)) return false // different register
  }
  // Last resort: same email address (only when the reg no is blank on the row)
  if (email && !rowReg) {
    const rowEmail = String(r.email_address || r.email || '').trim().toLowerCase()
    if (rowEmail && rowEmail === email) return true
  }
  return false
}

async function fetchPaidPage(search, page, authHeader) {
  const url = `${DATA_API_BASE}/paid-records?${new URLSearchParams({ search, page: String(page) })}`
  const res = await fetch(url, {
    headers: authHeader ? { Authorization: authHeader } : {},
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`paid-records lookup failed (${res.status})`)
  return res.json()
}

export async function findPaidRecords(regNo, years, authHeader, { email } = {}) {
  const target = compactReg(regNo)
  const found = {}
  if (!target) return found
  const mail = String(email || '').trim().toLowerCase() || null

  // paid-records' search is a LIKE over name/email/reg_no/licence no, so
  // "TR289" misses a row stored as "TR 289" or "289". Try the variants in
  // turn (stopping as soon as every year is found).
  const digits = regDigits(target)
  const prefix = regPrefix(target)
  const variants = [...new Set([
    normReg(regNo),
    target,
    prefix && digits ? `${prefix} ${digits}` : null,
    prefix && digits ? `${prefix}/${digits}` : null,
    digits || null,
    mail,
  ].filter(Boolean))]

  for (const search of variants) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await fetchPaidPage(search, page, authHeader)
      for (const r of body?.data ?? []) {
        if (String(r.receipt_type || '').toUpperCase() === 'DELETED') continue
        if (!sameEngineer(r, target, mail)) continue
        // year_paid is the source of truth; license_no "1540/2026" as backup
        const y = Number(r.year_paid) || Number(String(r.license_no || '').split('/')[1]) || null
        if (y && years.includes(y) && !found[y]) found[y] = r
      }
      if (years.every(y => found[y])) return found
      const totalPages = body?.pagination?.totalPages ?? 1
      if (page >= totalPages) break
    }
  }
  return found
}

// Registration type (fee category) for renewals, from the licence register
// row (base_field) or the reg-no prefix — NOT the discipline ("Civil"),
// which says nothing about permanent vs temporary.
export function feeCategoryFrom({ regNo, record } = {}) {
  const bf = String(record?.base_field || record?.type || '').toUpperCase()
  if (bf.includes('TEMP'))     return 'TEMPORARY'
  if (bf.includes('TECHNICI')) return 'TECHNICIAN'
  if (bf.includes('TECHNOLO')) return 'TECHNOLOGIST'
  if (regPrefix(regNo) === 'TR') return 'TEMPORARY'
  if (bf.includes('PERM') || bf.includes('CORP')) return 'CORPORATE'
  return null
}

// Year a renewal transaction applies to.
const txYear = (tx) => tx.renewal_year || new Date(tx.createdAt || tx.created_at).getFullYear()

export async function findRenewalTransactions(regNo, years) {
  const target = normReg(regNo)
  if (!target) return {}
  const ids = [...new Set([target, compactReg(regNo)].filter(Boolean))]
  const rows = await PaymentTransaction.findAll({
    where: {
      purpose: 'RENEWAL',
      status: { [Op.notIn]: ['DELETED', 'FAILED'] },
      [Op.or]: [{ registration_number: { [Op.in]: ids } }, { application_id: { [Op.in]: ids } }],
    },
    order: [['createdAt', 'DESC']],
    limit: 50,
  })

  // Per year keep the most meaningful row: APPROVED > PENDING > REJECTED
  const rank = { APPROVED: 3, PENDING: 2, REJECTED: 1 }
  const byYear = {}
  for (const tx of rows) {
    const y = txYear(tx)
    if (!years.includes(y)) continue
    const status = tx.renewal_status || 'PENDING'
    const prev = byYear[y]
    if (!prev || (rank[status] || 0) > (rank[prev.renewal_status || 'PENDING'] || 0)) byYear[y] = tx
  }
  return byYear
}

// state: 'licensed' | 'paid' | 'pending_review' | 'rejected' | 'none'
export async function getLicenceStatus(regNo, authHeader, { email } = {}) {
  const years = allowedRenewalYears()
  let paid = {}
  let paidRecordsError = null
  try {
    paid = await findPaidRecords(regNo, years, authHeader, { email })
  } catch (e) {
    paidRecordsError = e.message
  }
  const txs = await findRenewalTransactions(regNo, years)

  const result = {}
  for (const y of years) {
    const rec = paid[y]
    const tx  = txs[y]
    if (rec) {
      result[y] = {
        state: 'licensed',
        licence_no: rec.license_no || `${normReg(regNo)}/${y}`,
        license_status: rec.license_status || null,
        amount_paid: rec.amount_paid ?? null,
        base_field: rec.base_field || null,
      }
    } else if (tx) {
      const s = tx.renewal_status || 'PENDING'
      result[y] = {
        state: s === 'APPROVED' ? 'paid' : s === 'REJECTED' ? 'rejected' : 'pending_review',
        transaction_ref: tx.transaction_ref,
        payment_method: tx.payment_method,
        submitted_at: tx.createdAt,
        review_comment: tx.renewal_review_comment || null,
      }
    } else {
      result[y] = { state: 'none' }
    }
  }

  const anyRecord = paid[years[0]] || paid[years[1]] || null
  return {
    reg_no: normReg(regNo),
    current_year: years[0],
    next_year: years[1],
    years: result,
    // PERMANENT/CORPORATE | TEMPORARY | TECHNOLOGIST | TECHNICIAN, or null
    // if neither the register nor the reg no says — the frontend then
    // falls back to the profile.
    fee_category: feeCategoryFrom({ regNo, record: anyRecord }),
    paid_records_error: paidRecordsError,
  }
}

// True when a new renewal payment for `year` should be refused.
export async function renewalAlreadyCovered(regNo, year, authHeader, opts = {}) {
  const status = await getLicenceStatus(regNo, authHeader, opts)
  const s = status.years[year]?.state
  if (s === 'licensed') return `A licence for ${year} is already on record for ${status.reg_no}.`
  if (s === 'paid') return `Your ${year} renewal has already been paid and approved.`
  if (s === 'pending_review') return `A ${year} renewal payment is already awaiting Accounts review.`
  return null
}
