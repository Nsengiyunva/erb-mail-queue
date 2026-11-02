// ══════════════════════════════════════════════════════════════════
// Sent receipts — every receipt the system has emailed, in one list
// ══════════════════════════════════════════════════════════════════
// Mounted at /api/erb/receipt/sent (see receipt_routes.js).
//
// Receipts are emailed from three places, each with its own bookkeeping:
//
//   kind "tx"   payment_transactions.receipt_email_status
//               Application, registration and renewal fees — online
//               payments confirmed by the gateway, and payments Accounts
//               verified (application fee, renewal approval, registration
//               fee). PDF: RECEIPT_PDF_DIR/receipt_<ref>.pdf
//   kind "app"  erb_applications.accounts_receipt_email_status
//               Application fee paid with a receipt attached on the form
//               (no payment_transactions row), verified by Accounts.
//               PDF: RECEIPT_PDF_DIR/receipt_ERB-<id>-ACCTVERIFIED.pdf
//   kind "file" erb_receipts
//               Annual licence receipts sent from the Receipts admin page
//               (single + Excel bulk upload) and WED receipts.
//
// Same soft-auth convention as the other receipt routes:
//   • admins send `x-user-role` (REGISTRAR, CHAIRMAN, ACCOUNTS, REGISTRATION,
//     ADMINISTRATION) and see everyone's receipts;
//   • an applicant/engineer sends `x-applicant-id` (their user id) and,
//     optionally, `?email=` (their login email, used to match receipts
//     that are only keyed by email) and sees only their own.
//
//   GET  /                     list (paginated, filterable)
//   GET  /:kind/:id/pdf        the receipt PDF (regenerated if missing)
//   POST /:kind/:id/resend     admin: email it again

import express  from 'express'
import fs       from 'fs'
import path     from 'path'
import { DataTypes, Op } from 'sequelize'
import { sequelize }   from '../config/database.js'
import ReceiptModel    from '../models/Receipt.js'
import { Application } from '../models/index.js'
import receiptQueue    from '../queues/receipt_queue.js'
import { formatApplicantName } from '../utils/applicant-name.js'
import { generateReceiptPdf, RECEIPT_PDF_DIR, PAID_VIA_LABEL, receiptPdfPathFor } from '../utils/receipt-pdf.js'
import { resolveQuotedFee } from '../utils/fee-schedule.js'
import {
  PaymentTransaction,
  maybeSendReceiptEmail,
  sendAccountsVerificationReceipt,
  resolveQuotedAmount,
  accountsVerificationReceiptTx,
} from '../controllers/receipt-controller.js'

const router  = express.Router()
const Receipt = sequelize.models.Receipt || ReceiptModel(sequelize, DataTypes)

const ADMIN_ROLES = ['REGISTRAR', 'CHAIRMAN', 'ACCOUNTS', 'REGISTRATION', 'ADMINISTRATION']
// ISSUED = created by staff without emailing it (still visible/downloadable).
const EMAIL_STATUSES = ['SENT', 'QUEUED', 'FAILED', 'ISSUED']
const VISIBLE_TO_APPLICANT = ['SENT', 'QUEUED', 'ISSUED']
const MAX_PAGE_SIZE  = 100

// ── Who is asking ─────────────────────────────────────────────────
function viewerOf(req) {
  const role = String(req.headers['x-user-role'] || '').toUpperCase()
  if (ADMIN_ROLES.includes(role)) return { admin: true, role }

  const applicantId = parseInt(req.headers['x-applicant-id'], 10)
  const email = String(req.query.email || '').trim().toLowerCase()
  // Registered engineers: their licence / registration number. Renewal and
  // registration payments are keyed by it, and an engineer's account is not
  // always the same user id (or email) they applied with.
  const regNo = String(req.query.reg_no || '').trim().slice(0, 50)
  if (!applicantId && !email && !regNo) return null
  return {
    admin:       false,
    applicantId: Number.isFinite(applicantId) && applicantId > 0 ? applicantId : null,
    email:       /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    regNo:       regNo || null,
    appIds:      [],
  }
}

// The viewer's own licence applications — matched by user id, email or the
// licence number they were issued. Lets an engineer whose account id/email
// changed after registration still see their application-fee and
// registration-fee receipts (those transactions point at the application).
async function resolveViewerApplications(viewer) {
  if (!viewer || viewer.admin) return viewer
  const or = []
  if (viewer.applicantId) or.push({ applicant_id: viewer.applicantId })
  if (viewer.email)       or.push({ email_address: viewer.email })
  if (viewer.regNo)       or.push({ license_number: viewer.regNo })
  if (!or.length) return viewer
  const apps = await Application.findAll({ where: { [Op.or]: or }, attributes: ['id'], limit: 50 })
  viewer.appIds = apps.map(a => a.id)
  return viewer
}

const like = (v) => ({ [Op.like]: `%${v}%` })

// erb_receipts.email can hold "a@x.com;b@y.com" (see InvoiceList.js) — match
// the address as a whole entry, not as a substring of another address.
const emailEntryWhere = (email) => ({
  [Op.or]: [
    { email },
    { email: { [Op.like]: `${email};%` } },
    { email: { [Op.like]: `%;${email}` } },
    { email: { [Op.like]: `%;${email};%` } },
  ],
})
const emailListHas = (list, email) =>
  String(list || '').toLowerCase().split(/[;,]/).map(s => s.trim()).includes(email)

// ── Purpose of an erb_receipts row ───────────────────────────────
// WED uploads are stored as wed-<ts>_<name> (see /upload-wed-receipt).
const fileKindPurpose = (r) => (String(r.file_name || '').startsWith('wed-') ? 'WED' : 'LICENCE')

// ── Row shapes ───────────────────────────────────────────────────
const normStatus = (s) => String(s || '').toUpperCase() || null

function txRow(t) {
  return {
    key:             `tx-${t.id}`,
    kind:            'tx',
    id:              t.id,
    purpose:         String(t.purpose || 'APPLICATION').toUpperCase(),
    reference:       t.transaction_ref,
    application_id:  t.application_id,
    applicant_id:    t.applicant_id,
    applicant_name:  t.applicant_name || null,
    email:           t.email || null,
    amount:          t.quoted_amount ?? null, // filled in below when missing
    method:          String(t.payment_method || t.provider || '').toUpperCase() === 'RECEIPT' ? 'RECEIPT' : 'ONLINE',
    provider:        t.provider || null,
    renewal_year:    t.renewal_year || null,
    email_status:    normStatus(t.receipt_email_status),
    source:          t.source || 'SYSTEM',
    paid_via:        t.paid_via || null,
    issued_by:       t.issued_by || null,
    paid_at:         t.paid_on || t.gateway_confirmed_at || t.createdAt || null,
    sent_at:         t.receipt_sent_at || t.updatedAt || null,
  }
}

function appRow(a) {
  const r = accountsVerificationReceiptTx(a)
  return {
    key:             `app-${a.id}`,
    kind:            'app',
    id:              a.id,
    purpose:         'APPLICATION',
    reference:       r.transaction_ref,
    application_id:  String(a.id),
    applicant_id:    a.applicant_id,
    applicant_name:  formatApplicantName(a),
    email:           a.email_address || null,
    amount:          r.amount ?? null,
    method:          'RECEIPT',
    provider:        null,
    renewal_year:    null,
    email_status:    normStatus(a.accounts_receipt_email_status),
    paid_at:         a.created_at || null,
    sent_at:         a.accounts_verified_at || a.updated_at || null,
  }
}

function fileRow(r) {
  const status = String(r.status || '').toLowerCase()
  return {
    key:             `file-${r.id}`,
    kind:            'file',
    id:              r.id,
    purpose:         fileKindPurpose(r),
    reference:       r.original_name || r.file_name,
    application_id:  null,
    applicant_id:    null,
    applicant_name:  null,
    email:           r.email || null,
    amount:          null,
    method:          null,
    provider:        null,
    renewal_year:    null,
    email_status:    status === 'sent' ? 'SENT' : status === 'failed' ? 'FAILED' : 'QUEUED',
    paid_at:         null,
    sent_at:         r.created_at || null,
  }
}

// ── Per-source WHERE clauses ─────────────────────────────────────
// Each returns null when that source can't contain matches for the
// requested filters (so it is skipped entirely).

function txWhere({ viewer, purpose, status, search }) {
  if (purpose && !['APPLICATION', 'REGISTRATION', 'RENEWAL'].includes(purpose)) return null
  const and = [{ status: { [Op.ne]: 'DELETED' } }]

  // Applicants only see receipts that actually went (or are going) out.
  const statuses = viewer.admin ? EMAIL_STATUSES : VISIBLE_TO_APPLICANT
  if (status && !statuses.includes(status)) return null
  and.push({ receipt_email_status: status ? status : { [Op.in]: statuses } })

  if (purpose === 'APPLICATION') and.push({ [Op.or]: [{ purpose: 'APPLICATION' }, { purpose: null }, { purpose: '' }] })
  else if (purpose) and.push({ purpose })

  if (!viewer.admin) {
    const who = []
    if (viewer.applicantId)   who.push({ applicant_id: viewer.applicantId })
    if (viewer.email)         who.push({ email: viewer.email })
    if (viewer.regNo)         who.push({ registration_number: viewer.regNo }, { application_id: viewer.regNo })
    if (viewer.appIds.length) who.push({ application_id: { [Op.in]: viewer.appIds.map(String) } })
    if (!who.length) return null
    and.push({ [Op.or]: who })
  }

  if (search) {
    and.push({ [Op.or]: [
      { applicant_name: like(search) }, { email: like(search) },
      { transaction_ref: like(search) }, { application_id: like(search) },
      { registration_number: like(search) },
    ] })
  }
  return { [Op.and]: and }
}

function appWhere({ viewer, purpose, status, search }) {
  if (purpose && purpose !== 'APPLICATION') return null
  const statuses = viewer.admin ? EMAIL_STATUSES : VISIBLE_TO_APPLICANT
  if (status && !statuses.includes(status)) return null

  const and = [
    { accounts_receipt_email_status: status ? status : { [Op.in]: statuses } },
    { [Op.or]: [{ status: null }, { status: { [Op.ne]: 'DELETED' } }] },
  ]
  if (!viewer.admin) {
    if (!viewer.appIds.length) return null
    and.push({ id: { [Op.in]: viewer.appIds } })
  }
  if (search) {
    and.push({ [Op.or]: [
      { first_name: like(search) }, { surname: like(search) }, { other_names: like(search) },
      { email_address: like(search) }, { id: like(search) },
    ] })
  }
  return { [Op.and]: and }
}

function fileWhere({ viewer, purpose, status, search }) {
  if (purpose && !['LICENCE', 'WED'].includes(purpose)) return null
  const statusMap = { SENT: 'sent', FAILED: 'failed', QUEUED: 'pending' }
  const statuses = viewer.admin ? ['sent', 'failed', 'pending'] : ['sent', 'pending']
  if (status && !statuses.includes(statusMap[status])) return null

  const and = [{ status: status ? statusMap[status] : { [Op.in]: statuses } }]
  if (purpose === 'WED')     and.push({ file_name: { [Op.like]: 'wed-%' } })
  if (purpose === 'LICENCE') and.push({ file_name: { [Op.notLike]: 'wed-%' } })

  if (!viewer.admin) {
    // These rows are keyed only by the address the receipt went to.
    if (!viewer.email) return null
    and.push(emailEntryWhere(viewer.email))
  }
  if (search) and.push({ [Op.or]: [{ email: like(search) }, { original_name: like(search) }] })
  return { [Op.and]: and }
}

// ── GET / ─────────────────────────────────────────────────────────
// ?page=1&limit=20&purpose=APPLICATION|REGISTRATION|RENEWAL|LICENCE|WED
// &status=SENT|QUEUED|FAILED (admin)&search=…&email=… (applicant)
//
// Pagination across three tables: the first page*limit rows of each
// (newest first) are enough to build any page of the merged list.
router.get('/', async (req, res) => {
  const viewer = viewerOf(req)
  if (!viewer) return res.status(401).json({ message: 'Sign in to view receipts' })

  try {
    await resolveViewerApplications(viewer)
    const page    = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit   = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const purpose = String(req.query.purpose || '').toUpperCase() || null
    const status  = String(req.query.status  || '').toUpperCase() || null
    const search  = String(req.query.search || '').trim().slice(0, 100)
    const filters = { viewer, purpose: purpose === 'ALL' ? null : purpose, status: status === 'ALL' ? null : status, search }
    const take    = page * limit

    const tw = txWhere(filters)
    const aw = appWhere(filters)
    const fw = fileWhere(filters)

    const [txRows, txCount, appRows, appCount, fileRows, fileCount] = await Promise.all([
      tw ? PaymentTransaction.findAll({ where: tw, order: [['updatedAt', 'DESC']], limit: take }) : [],
      tw ? PaymentTransaction.count({ where: tw }) : 0,
      aw ? Application.findAll({ where: aw, order: [['accounts_verified_at', 'DESC'], ['updated_at', 'DESC']], limit: take }) : [],
      aw ? Application.count({ where: aw }) : 0,
      fw ? Receipt.findAll({ where: fw, order: [['created_at', 'DESC']], limit: take }) : [],
      fw ? Receipt.count({ where: fw }) : 0,
    ])

    // Older rows have no quoted_amount — resolve the nominal fee the same
    // way the PDF did, so the list shows what the receipt shows.
    const txs = await Promise.all(txRows.map(async r => {
      const t = r.toJSON()
      const row = txRow(t)
      if (row.amount == null) row.amount = await resolveQuotedAmount(t).catch(() => t.amount ?? null)
      return row
    }))

    // Applicant-facing: an erb_receipts match on a substring of a longer
    // address list is double-checked here.
    const files = fileRows.map(r => r.toJSON())
      .filter(r => viewer.admin || emailListHas(r.email, viewer.email))
      .map(fileRow)

    const merged = [...txs, ...appRows.map(a => appRow(a.toJSON())), ...files]
      .sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0))

    const total = txCount + appCount + fileCount
    const rows  = merged.slice((page - 1) * limit, page * limit)

    // Per-purpose totals for the filter chips (ignores the purpose filter).
    const countsFor = async (p) => {
      const f = { ...filters, purpose: p }
      const [a, b, c] = await Promise.all([
        txWhere(f)   ? PaymentTransaction.count({ where: txWhere(f) }) : 0,
        appWhere(f)  ? Application.count({ where: appWhere(f) }) : 0,
        fileWhere(f) ? Receipt.count({ where: fileWhere(f) }) : 0,
      ])
      return a + b + c
    }
    const PURPOSES = ['APPLICATION', 'REGISTRATION', 'RENEWAL', 'LICENCE', 'WED']
    const purposeCounts = Object.fromEntries(
      await Promise.all(PURPOSES.map(async p => [p, await countsFor(p)]))
    )
    purposeCounts.ALL = PURPOSES.reduce((s, p) => s + purposeCounts[p], 0)

    return res.json({
      receipts: rows,
      counts:   purposeCounts,
      pagination: {
        currentPage:  page,
        perPage:      limit,
        totalRecords: total,
        totalPages:   Math.max(1, Math.ceil(total / limit)),
      },
    })
  } catch (err) {
    console.error('[GET /receipt/sent]', err.message)
    return res.status(500).json({ message: 'Failed to load receipts' })
  }
})

// ── Look up one receipt + check the viewer may see it ─────────────
async function findReceipt(kind, id, viewer) {
  if (!/^\d+$/.test(String(id))) return null

  if (kind === 'tx') {
    const t = await PaymentTransaction.findByPk(id)
    if (!t) return null
    const raw = t.toJSON()
    if (!raw.receipt_email_status || raw.status === 'DELETED') return null
    if (!viewer.admin) {
      const mine = (viewer.applicantId && Number(raw.applicant_id) === viewer.applicantId) ||
                   (viewer.email && String(raw.email || '').toLowerCase() === viewer.email) ||
                   (viewer.regNo && [raw.registration_number, raw.application_id].map(String).includes(viewer.regNo)) ||
                   viewer.appIds.map(String).includes(String(raw.application_id))
      if (!mine || raw.receipt_email_status === 'FAILED') return null
    }
    return { kind, model: t, raw }
  }

  if (kind === 'app') {
    const a = await Application.findByPk(id)
    if (!a) return null
    const raw = a.toJSON()
    if (!raw.accounts_receipt_email_status) return null
    if (!viewer.admin) {
      if (!viewer.appIds.map(String).includes(String(raw.id))) return null
      if (raw.accounts_receipt_email_status === 'FAILED') return null
    }
    return { kind, model: a, raw }
  }

  if (kind === 'file') {
    const r = await Receipt.findByPk(id)
    if (!r) return null
    const raw = r.toJSON()
    if (!viewer.admin) {
      if (!viewer.email || !emailListHas(raw.email, viewer.email)) return null
      if (String(raw.status).toLowerCase() === 'failed') return null
    }
    return { kind, model: r, raw }
  }

  return null
}

// Standard-layout file for a reference (older, pre-standard PDFs named
// receipt_<ref>.pdf are ignored here, so they get redrawn in the standard layout).
const pdfPathForRef = (ref) => receiptPdfPathFor(ref)

// Returns a path to the PDF on disk, regenerating system receipts if the
// original file was cleaned up. Uploaded files (kind "file") can't be rebuilt.
async function ensurePdf(found) {
  const { kind, raw } = found

  if (kind === 'file') {
    return raw.file_path && fs.existsSync(raw.file_path) ? raw.file_path : null
  }

  if (kind === 'tx') {
    const p = pdfPathForRef(raw.transaction_ref)
    if (fs.existsSync(p)) return p
    const amount = await resolveQuotedAmount(raw)
    return generateReceiptPdf({ ...raw, amount, status: 'SUCCESS', purpose: raw.purpose || 'APPLICATION' })
  }

  if (kind === 'app') {
    const receiptTx = accountsVerificationReceiptTx(raw)
    const p = pdfPathForRef(receiptTx.transaction_ref)
    if (fs.existsSync(p)) return p
    return generateReceiptPdf(receiptTx)
  }

  return null
}

// ══════════════════════════════════════════════════════════════════
// Staff: create a receipt manually
// ══════════════════════════════════════════════════════════════════
// For payments received outside the portal (bank deposit, cash, cheque,
// a mobile-money payment the watcher never saw, …). The receipt is stored
// as a receipt payment in payment_transactions — provider/payment_method
// 'RECEIPT', source 'ADMIN' — so the Payment Tracker counts it under
// "Collected via Receipt", the engineer sees it on their receipts page, and
// a RENEWAL is recorded as APPROVED for its year (licence-status.js).
//
//   GET  /lookup?q=…   find an application / engineer to fill the form
//   POST /preview      the PDF as it will look (nothing saved)
//   POST /create       save it, generate the PDF, optionally email it

const CREATE_PURPOSES = ['APPLICATION', 'REGISTRATION', 'RENEWAL']
const PAID_VIA = Object.keys(PAID_VIA_LABEL)
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim())

function requireAdmin(req, res) {
  const viewer = viewerOf(req)
  if (!viewer?.admin) { res.status(403).json({ message: 'Only ERB staff can create receipts' }); return null }
  return viewer
}

// ── Lookup: engineers database + applications ──────────────────────
// GET /lookup?q=  — searches the engineers database (data.erb.go.ug, the
// same source as the portal's "Engineers Database" page; the admin's
// Authorization header is forwarded) and licence applications, and returns
// each person with their details and the fee for every receipt type.
// Engineers come first; an application belonging to a listed engineer
// (licence number = reg no.) is folded into that engineer's row.
// If the engineers database can't be reached, applications are still
// returned with `engineers_error` set, so the form keeps working.
const ENGINEERS_API = process.env.ERB_ENGINEERS_API || 'https://data.erb.go.ug/api/engineers'
const firstOf = (list) => String(list || '').split(/[;,]/).map(x => x.trim()).find(Boolean) || null
const feesFor = (category) => Object.fromEntries(CREATE_PURPOSES.map(p => [p, resolveQuotedFee(p, category)]))
const normReg = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

// Fee category from an engineer's register type (PERMANENT → Engineer).
function categoryFromType(type) {
  const t = String(type || '').toUpperCase()
  if (t.startsWith('TEMP'))     return 'Temporary'
  if (t.startsWith('TECHNOLO')) return 'Technologist'
  if (t.startsWith('TECHNICI')) return 'Technician'
  if (!t) return null
  return 'Permanent'
}

async function searchEngineers(q, authorization) {
  const url = `${ENGINEERS_API}?${new URLSearchParams({ search: q, page: '1', limit: '8', licence_year: String(new Date().getFullYear()) })}`
  const res = await fetch(url, {
    headers: authorization ? { Authorization: authorization } : {},
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'not signed in to the engineers database' : `engineers database returned ${res.status}`)
  const body = await res.json()
  return (body?.data || []).map(e => {
    const type = e.type || e.effective_type || null
    const category = categoryFromType(type)
    return {
      source:              'ENGINEER',
      key:                 `eng-${e.id ?? e.reg_no}`,
      engineer_id:         e.id ?? null,
      application_id:      null,
      applicant_id:        e.account?.id ?? e.user_id ?? null,
      name:                e.name || null,
      email:               e.primary_email || firstOf(e.emails) || e.account?.email || null,
      phone:               e.primary_contact || firstOf(e.phones) || null,
      registration_number: e.reg_no || null,
      license_number:      e.reg_no || null,
      type,
      category,
      field:               e.field || null,
      organisation:        e.organisation || null,
      licence:             e.licence ? { year: e.licence.year, has_licence: !!e.licence.has_licence, renewal_status: e.licence.renewal_status || null } : null,
      status:              null,
      fees:                feesFor(category),
    }
  })
}

async function searchApplications(q) {
  const or = [
    { first_name: like(q) }, { surname: like(q) }, { other_names: like(q) },
    { email_address: like(q) }, { license_number: like(q) }, { telephone: like(q) },
  ]
  const asId = q.replace(/^ERB-?0*/i, '')
  if (/^\d+$/.test(asId)) or.push({ id: Number(asId) })
  const apps = await Application.findAll({
    where: { [Op.and]: [{ [Op.or]: or }, { [Op.or]: [{ status: null }, { status: { [Op.ne]: 'DELETED' } }] }] },
    order: [['updated_at', 'DESC']],
    limit: 10,
  })
  return apps.map(a => a.toJSON()).map(a => {
    const category = a.category || a.profession || null
    return {
      source:              'APPLICATION',
      key:                 `app-${a.id}`,
      engineer_id:         null,
      application_id:      a.id,
      applicant_id:        a.applicant_id,
      name:                formatApplicantName(a),
      email:               a.email_address || null,
      phone:               a.telephone || a.registered_phone_number || null,
      registration_number: a.license_number || null,
      license_number:      a.license_number || null,
      type:                null,
      category,
      field:               null,
      organisation:        null,
      licence:             null,
      status:              a.status || null,
      fees:                feesFor(category),
    }
  })
}

router.get('/lookup', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const q = String(req.query.q || '').trim().slice(0, 100)
  if (q.length < 2) return res.json({ results: [] })
  try {
    const [eng, apps] = await Promise.allSettled([searchEngineers(q, req.headers.authorization), searchApplications(q)])
    const engineers    = eng.status === 'fulfilled' ? eng.value : []
    const applications = apps.status === 'fulfilled' ? apps.value : []
    if (apps.status === 'rejected') console.error('[GET /receipt/sent/lookup] applications:', apps.reason?.message)

    // Fold an engineer's own application into their row (gives the receipt
    // an application number and links it to their portal account).
    const byReg = new Map(engineers.filter(e => e.registration_number).map(e => [normReg(e.registration_number), e]))
    const rest = []
    for (const a of applications) {
      const e = a.license_number && byReg.get(normReg(a.license_number))
      if (e) {
        e.application_id = e.application_id || a.application_id
        e.applicant_id   = e.applicant_id || a.applicant_id
        e.email          = e.email || a.email
        e.phone          = e.phone || a.phone
        if (!e.category) { e.category = a.category; e.fees = a.fees }
      } else rest.push(a)
    }

    return res.json({
      results: [...engineers, ...rest].slice(0, 15),
      ...(eng.status === 'rejected' ? { engineers_error: `Engineers database not searched (${eng.reason?.message || 'unavailable'}) — showing applications only.` } : {}),
    })
  } catch (err) {
    console.error('[GET /receipt/sent/lookup]', err.message)
    return res.status(500).json({ message: 'Lookup failed' })
  }
})

// GET /fees — the fee schedule, so the form can suggest the amount for
// details typed in by hand (category + receipt type).
router.get('/fees', (req, res) => {
  if (!requireAdmin(req, res)) return
  const categories = ['Permanent', 'Temporary', 'Technologist', 'Technician']
  return res.json({ fees: Object.fromEntries(categories.map(c => [c, feesFor(c)])) })
})

// Validates the form and builds the PaymentTransaction fields.
async function buildManualReceipt(body, viewer, { preview = false } = {}) {
  const errors = {}
  const purpose = String(body.purpose || '').toUpperCase()
  if (!CREATE_PURPOSES.includes(purpose)) errors.purpose = 'Choose application, registration or renewal'

  let application = null
  if (body.application_id != null && String(body.application_id).trim() !== '') {
    if (!/^\d+$/.test(String(body.application_id).trim())) errors.application_id = 'Application ID must be a number'
    else {
      application = await Application.findByPk(String(body.application_id).trim())
      if (!application) errors.application_id = `No application with ID ${body.application_id}`
    }
  }
  const app = application?.toJSON() || null

  const applicantName = String(body.applicant_name || '').trim() || (app ? formatApplicantName(app) : '')
  const email         = String(body.email || '').trim() || app?.email_address || ''
  const regNo         = String(body.registration_number || '').trim() || app?.license_number || ''
  const amount        = Number(String(body.amount ?? '').replace(/[,\s]/g, ''))
  const paidVia       = String(body.paid_via || '').toUpperCase()
  const paidOn        = body.paid_on ? new Date(body.paid_on) : new Date()
  const renewalYear   = parseInt(body.renewal_year, 10)
  const ref           = String(body.payment_reference || '').trim()

  if (!applicantName) errors.applicant_name = 'Enter the payer’s name'
  if (!isEmail(email)) errors.email = 'Enter a valid email address — receipts are matched to engineers by it'
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) errors.amount = 'Enter the amount paid in whole UGX'
  if (!PAID_VIA.includes(paidVia)) errors.paid_via = 'Choose how it was paid'
  if (isNaN(paidOn) || paidOn > new Date(Date.now() + 86400000)) errors.paid_on = 'Enter a valid payment date (not in the future)'
  if (purpose === 'RENEWAL') {
    if (!regNo) errors.registration_number = 'Renewals need the engineer’s registration / licence number'
    const maxY = new Date().getFullYear() + 1
    if (!Number.isInteger(renewalYear) || renewalYear < 2000 || renewalYear > maxY) errors.renewal_year = `Enter the licence year being renewed (2000–${maxY})`
  } else if (!app && !regNo) {
    errors.application_id = 'Pick the application (or enter a registration number)'
  }
  if (ref && !/^[A-Za-z0-9 _./-]{3,90}$/.test(ref)) errors.payment_reference = 'Use letters, numbers, spaces and - _ . / only'
  if (ref && !preview) {
    const taken = await PaymentTransaction.findOne({ where: { transaction_ref: ref } })
    if (taken) errors.payment_reference = `Reference ${ref} is already used (${taken.purpose || 'payment'} for ${taken.applicant_name || taken.application_id})`
  }

  const transactionRef = ref ||
    `ERB-${purpose.slice(0, 3)}-${(app?.id || regNo || 'X').toString().replace(/[^A-Za-z0-9]/g, '')}-${Date.now().toString(36).toUpperCase()}`

  const fields = {
    application_id:      String(app?.id || regNo),
    transaction_ref:     transactionRef,
    phone:               String(body.phone || '').trim() || app?.telephone || null,
    provider:            'RECEIPT',
    payment_method:      'RECEIPT',
    amount,
    quoted_amount:       amount,
    fee_category:        String(body.category || '').trim() || app?.category || app?.profession || null,
    applicant_name:      applicantName,
    applicant_id:        app?.applicant_id ?? (parseInt(body.applicant_id, 10) || null),
    status:              'SUCCESS',
    purpose,
    registration_number: purpose === 'RENEWAL' ? regNo : (regNo || String(app?.id || '')),
    email:               email.toLowerCase(),
    renewal_year:        purpose === 'RENEWAL' ? renewalYear : null,
    renewal_status:      purpose === 'RENEWAL' ? 'APPROVED' : null,
    renewal_reviewed_by: purpose === 'RENEWAL' ? (viewer.name || 'Accounts') : null,
    renewal_reviewed_at: purpose === 'RENEWAL' ? new Date() : null,
    renewal_review_comment: purpose === 'RENEWAL' ? 'Receipt issued manually from Sent Receipts.' : null,
    source:              'ADMIN',
    paid_via:            paidVia,
    paid_on:             isNaN(paidOn) ? new Date() : paidOn,
    issued_by:           viewer.name || null,
    issue_notes:         String(body.notes || '').trim().slice(0, 1000) || null,
  }
  return { errors, fields, application: app }
}

// Warn before issuing a second receipt for the same fee.
async function findDuplicateReceipt(fields) {
  const where = {
    purpose: fields.purpose,
    status: { [Op.ne]: 'DELETED' },
    receipt_email_status: { [Op.ne]: null },
    [Op.or]: [
      { application_id: fields.application_id },
      ...(fields.registration_number ? [{ registration_number: fields.registration_number }] : []),
    ],
  }
  if (fields.purpose === 'RENEWAL') where.renewal_year = fields.renewal_year
  const dup = await PaymentTransaction.findOne({ where, order: [['updatedAt', 'DESC']] })
  return dup ? dup.toJSON() : null
}

const adminName = (req) => String(req.body?.issued_by || '').trim().slice(0, 200) || null

// POST /preview — renders the PDF for the form as entered; nothing saved.
router.post('/preview', async (req, res) => {
  const viewer = requireAdmin(req, res); if (!viewer) return
  viewer.name = adminName(req)
  try {
    const { errors, fields } = await buildManualReceipt(req.body || {}, viewer, { preview: true })
    if (Object.keys(errors).length) return res.status(422).json({ message: 'Please fix the highlighted fields', errors })
    const filePath = await generateReceiptPdf(fields, { preview: true })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline; filename="receipt-preview.pdf"')
    return res.sendFile(path.resolve(filePath), () => fs.unlink(filePath, () => {}))
  } catch (err) {
    console.error('[POST /receipt/sent/preview]', err.message)
    return res.status(500).json({ message: 'Could not build the preview' })
  }
})

// POST /create — body: purpose, application_id | registration_number,
// applicant_name, email, phone, amount, paid_via, paid_on, payment_reference,
// renewal_year (RENEWAL), notes, send_email (default true), issued_by,
// confirm_duplicate (true to issue despite an existing receipt).
router.post('/create', async (req, res) => {
  const viewer = requireAdmin(req, res); if (!viewer) return
  viewer.name = adminName(req)
  try {
    const body = req.body || {}
    const { errors, fields } = await buildManualReceipt(body, viewer)
    if (Object.keys(errors).length) return res.status(422).json({ message: 'Please fix the highlighted fields', errors })

    if (!body.confirm_duplicate) {
      const dup = await findDuplicateReceipt(fields)
      if (dup) {
        return res.status(409).json({
          code: 'DUPLICATE',
          message: `A ${fields.purpose.toLowerCase()} receipt${fields.purpose === 'RENEWAL' ? ` for ${fields.renewal_year}` : ''} already exists for ${dup.applicant_name || fields.applicant_name} (ref ${dup.transaction_ref}).`,
          existing: { id: dup.id, transaction_ref: dup.transaction_ref, amount: dup.quoted_amount ?? dup.amount, sent_at: dup.receipt_sent_at || dup.updatedAt },
        })
      }
    }

    const sendEmail = body.send_email !== false && body.send_email !== 'false'
    const record = await PaymentTransaction.create(fields)
    const tx = record.toJSON()

    if (sendEmail) {
      // Same pipeline as every other receipt: PDF → paymentReceiptQueue → email.
      await maybeSendReceiptEmail(tx, { email: tx.email })
    } else {
      await generateReceiptPdf({ ...tx, amount: tx.quoted_amount })
      await PaymentTransaction.update({ receipt_email_status: 'ISSUED' }, { where: { id: tx.id } })
    }

    const fresh = (await PaymentTransaction.findByPk(tx.id)).toJSON()
    console.log(`[sent-receipts] ${fresh.purpose} receipt ${fresh.transaction_ref} issued manually by ${fresh.issued_by || 'staff'} (${sendEmail ? 'emailed' : 'not emailed'})`)
    return res.status(201).json({
      message: sendEmail ? `Receipt created and emailed to ${fresh.email}` : 'Receipt created (not emailed)',
      receipt: txRow(fresh),
    })
  } catch (err) {
    console.error('[POST /receipt/sent/create]', err.message)
    return res.status(500).json({ message: 'Could not create the receipt' })
  }
})

// ── GET /:kind/:id/pdf ────────────────────────────────────────────
// Headers as for the list. ?download=1 forces a download instead of
// opening inline.
router.get('/:kind/:id/pdf', async (req, res) => {
  const viewer = viewerOf(req)
  if (!viewer) return res.status(401).json({ message: 'Sign in to view receipts' })

  try {
    await resolveViewerApplications(viewer)
    const found = await findReceipt(req.params.kind, req.params.id, viewer)
    if (!found) return res.status(404).json({ message: 'Receipt not found' })

    const filePath = await ensurePdf(found)
    if (!filePath) return res.status(404).json({ message: 'The receipt file is no longer available' })

    const ref = found.kind === 'file'
      ? (found.raw.original_name || path.basename(filePath))
      : `ERB_Receipt_${found.kind === 'app' ? accountsVerificationReceiptTx(found.raw).transaction_ref : found.raw.transaction_ref}.pdf`
    const safeName = String(ref).replace(/[^a-zA-Z0-9._-]/g, '_')
    const disposition = req.query.download ? 'attachment' : 'inline'

    res.setHeader('Content-Type', path.extname(filePath).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream')
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`)
    return res.sendFile(path.resolve(filePath))
  } catch (err) {
    console.error('[GET /receipt/sent/:kind/:id/pdf]', err.message)
    return res.status(500).json({ message: 'Could not open this receipt' })
  }
})

// ── POST /:kind/:id/resend ────────────────────────────────────────
// Admin only. Re-emails the same receipt (e.g. after a FAILED send, or when
// the engineer says it never arrived).
router.post('/:kind/:id/resend', async (req, res) => {
  const viewer = viewerOf(req)
  if (!viewer?.admin) return res.status(403).json({ message: 'Only ERB staff can resend receipts' })

  try {
    const found = await findReceipt(req.params.kind, req.params.id, viewer)
    if (!found) return res.status(404).json({ message: 'Receipt not found' })
    const { kind, raw } = found

    if (kind === 'tx') {
      await PaymentTransaction.update({ receipt_email_status: null }, { where: { id: raw.id } })
      await maybeSendReceiptEmail({ ...raw, receipt_email_status: null, status: 'SUCCESS' })
    } else if (kind === 'app') {
      await Application.update({ accounts_receipt_email_status: null }, { where: { id: raw.id } })
      await sendAccountsVerificationReceipt({ ...raw, accounts_receipt_email_status: null })
    } else {
      if (!raw.file_path || !fs.existsSync(raw.file_path)) {
        return res.status(410).json({ message: 'The receipt file is no longer on the server — upload it again' })
      }
      await Receipt.update({ status: 'pending' }, { where: { id: raw.id } })
      await receiptQueue.add('send-receipt',
        { receiptId: raw.id, email: raw.email, filePath: raw.file_path, originalName: raw.original_name },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }
      )
    }

    return res.json({ message: 'Receipt queued to be emailed again', email_status: 'QUEUED' })
  } catch (err) {
    console.error('[POST /receipt/sent/:kind/:id/resend]', err.message)
    return res.status(500).json({ message: 'Could not resend this receipt' })
  }
})

// ── Startup backfill: receipts emailed before the status was recorded ──
// Before receipt_email_status existed on payment_transactions (and before
// accounts_receipt_email_status on erb_applications), receipts were
// generated and emailed but never marked SENT — so they would never show up
// on anyone's receipts page. The PDF is only written immediately before the
// email is queued, so a PDF on disk for a transaction with no recorded
// status means its receipt went out: mark those SENT. Idempotent, and only
// ever touches rows whose status is still null.
export async function backfillLegacySentReceipts() {
  let files = []
  try { files = fs.readdirSync(RECEIPT_PDF_DIR) } catch { return { tx: 0, app: 0 } }
  const refs = new Set(
    // old layout: receipt_<ref>.pdf · standard layout: erb-receipt_<ref>.pdf
    files.filter(f => /^(erb-)?receipt_.+\.pdf$/i.test(f)).map(f => f.replace(/^(erb-)?receipt_/i, '').replace(/\.pdf$/i, ''))
  )
  if (!refs.size) return { tx: 0, app: 0 }

  const safe = (ref) => String(ref).replace(/[^a-zA-Z0-9_-]/g, '_')

  const txs = await PaymentTransaction.findAll({
    where: { receipt_email_status: null, status: { [Op.ne]: 'DELETED' } },
    attributes: ['id', 'transaction_ref', 'updatedAt'],
  })
  const txIds = txs.filter(t => refs.has(safe(t.transaction_ref))).map(t => t.id)
  if (txIds.length) {
    await PaymentTransaction.update(
      { receipt_email_status: 'SENT' },
      { where: { id: { [Op.in]: txIds } }, silent: true } // keep updatedAt (used as the sent date)
    )
  }

  const appIds = [...refs]
    .map(r => /^ERB-(\d+)-ACCTVERIFIED$/.exec(r)?.[1])
    .filter(Boolean)
  let appCount = 0
  if (appIds.length) {
    const [n] = await Application.update(
      { accounts_receipt_email_status: 'SENT' },
      { where: { id: { [Op.in]: appIds }, accounts_receipt_email_status: null }, silent: true }
    )
    appCount = n
  }

  if (txIds.length || appCount) {
    console.log(`[sent-receipts] backfill: marked ${txIds.length} payment receipt(s) and ${appCount} application receipt(s) as sent (PDF on file, status never recorded)`)
  }
  return { tx: txIds.length, app: appCount }
}

export default router
