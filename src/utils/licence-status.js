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

const normReg = (v) => String(v ?? '').trim().replace(/\/\d{4}$/, '').toUpperCase()

export async function findPaidRecords(regNo, years, authHeader) {
  const target = normReg(regNo)
  const found = {}
  if (!target) return found

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${DATA_API_BASE}/paid-records?${new URLSearchParams({ search: target, page: String(page) })}`
    const res = await fetch(url, {
      headers: authHeader ? { Authorization: authHeader } : {},
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`paid-records lookup failed (${res.status})`)
    const body = await res.json()

    for (const r of body?.data ?? []) {
      if (normReg(r.reg_no) !== target) continue
      if (String(r.receipt_type || '').toUpperCase() === 'DELETED') continue
      // year_paid is the source of truth; license_no "1540/2026" as backup
      const y = Number(r.year_paid) || Number(String(r.license_no || '').split('/')[1]) || null
      if (y && years.includes(y) && !found[y]) found[y] = r
    }

    if (years.every(y => found[y])) break
    const totalPages = body?.pagination?.totalPages ?? 1
    if (page >= totalPages) break
  }
  return found
}

// Year a renewal transaction applies to.
const txYear = (tx) => tx.renewal_year || new Date(tx.createdAt || tx.created_at).getFullYear()

export async function findRenewalTransactions(regNo, years) {
  const target = normReg(regNo)
  if (!target) return {}
  const rows = await PaymentTransaction.findAll({
    where: {
      purpose: 'RENEWAL',
      status: { [Op.notIn]: ['DELETED', 'FAILED'] },
      [Op.or]: [{ registration_number: target }, { application_id: target }],
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
export async function getLicenceStatus(regNo, authHeader) {
  const years = allowedRenewalYears()
  let paid = {}
  let paidRecordsError = null
  try {
    paid = await findPaidRecords(regNo, years, authHeader)
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

  return {
    reg_no: normReg(regNo),
    current_year: years[0],
    next_year: years[1],
    years: result,
    paid_records_error: paidRecordsError,
  }
}

// True when a new renewal payment for `year` should be refused.
export async function renewalAlreadyCovered(regNo, year, authHeader) {
  const status = await getLicenceStatus(regNo, authHeader)
  const s = status.years[year]?.state
  if (s === 'licensed') return `A licence for ${year} is already on record for ${status.reg_no}.`
  if (s === 'paid') return `Your ${year} renewal has already been paid and approved.`
  if (s === 'pending_review') return `A ${year} renewal payment is already awaiting Accounts review.`
  return null
}
