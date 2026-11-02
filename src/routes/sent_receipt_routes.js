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
import { generateReceiptPdf, RECEIPT_PDF_DIR } from '../utils/receipt-pdf.js'
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
const EMAIL_STATUSES = ['SENT', 'QUEUED', 'FAILED']
const MAX_PAGE_SIZE  = 100

// ── Who is asking ─────────────────────────────────────────────────
function viewerOf(req) {
  const role = String(req.headers['x-user-role'] || '').toUpperCase()
  if (ADMIN_ROLES.includes(role)) return { admin: true, role }

  const applicantId = parseInt(req.headers['x-applicant-id'], 10)
  const email = String(req.query.email || '').trim().toLowerCase()
  if (!applicantId && !email) return null
  return {
    admin:       false,
    applicantId: Number.isFinite(applicantId) && applicantId > 0 ? applicantId : null,
    email:       /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
  }
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
    paid_at:         t.gateway_confirmed_at || t.createdAt || null,
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
  const statuses = viewer.admin ? EMAIL_STATUSES : ['SENT', 'QUEUED']
  if (status && !statuses.includes(status)) return null
  and.push({ receipt_email_status: status ? status : { [Op.in]: statuses } })

  if (purpose === 'APPLICATION') and.push({ [Op.or]: [{ purpose: 'APPLICATION' }, { purpose: null }, { purpose: '' }] })
  else if (purpose) and.push({ purpose })

  if (!viewer.admin) {
    const who = []
    if (viewer.applicantId) who.push({ applicant_id: viewer.applicantId })
    if (viewer.email)       who.push({ email: viewer.email })
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
  const statuses = viewer.admin ? EMAIL_STATUSES : ['SENT', 'QUEUED']
  if (status && !statuses.includes(status)) return null

  const and = [
    { accounts_receipt_email_status: status ? status : { [Op.in]: statuses } },
    { [Op.or]: [{ status: null }, { status: { [Op.ne]: 'DELETED' } }] },
  ]
  if (!viewer.admin) {
    // Applications are always tied to the applicant's user id.
    if (!viewer.applicantId) return null
    and.push({ applicant_id: viewer.applicantId })
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
                   (viewer.email && String(raw.email || '').toLowerCase() === viewer.email)
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
      if (!viewer.applicantId || Number(raw.applicant_id) !== viewer.applicantId) return null
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

const pdfPathForRef = (ref) =>
  path.join(RECEIPT_PDF_DIR, `receipt_${String(ref).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`)

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

// ── GET /:kind/:id/pdf ────────────────────────────────────────────
// Headers as for the list. ?download=1 forces a download instead of
// opening inline.
router.get('/:kind/:id/pdf', async (req, res) => {
  const viewer = viewerOf(req)
  if (!viewer) return res.status(401).json({ message: 'Sign in to view receipts' })

  try {
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

export default router
