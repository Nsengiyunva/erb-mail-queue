// ══════════════════════════════════════════════════════════════════
// Receipt PDFs — adapters onto the ERB standard receipt
// ══════════════════════════════════════════════════════════════════
// Both generators below map their data onto the single approved layout in
// utils/standard-receipt.js. Nothing here draws anything itself.
//
//   generateReceiptPdf(tx)              application / registration / renewal
//                                       fees (payment_transactions rows and
//                                       the accounts-verified application-
//                                       form receipt)
//   generateEngineerReceiptPdf(record)  annual licence & WED receipts
//                                       (data.erb.go.ug paid-records shape)

import fs   from 'fs'
import path from 'path'
import crypto from 'crypto'
import { renderStandardReceipt, assignReceiptNumber } from './standard-receipt.js'
import { resolveFeeCategory } from './fee-schedule.js'

// Where generated receipt PDFs are written. Override with RECEIPT_PDF_DIR.
export const RECEIPT_PDF_DIR = process.env.RECEIPT_PDF_DIR || '/home/user1/ERB/receipts'

if (!fs.existsSync(RECEIPT_PDF_DIR)) {
  fs.mkdirSync(RECEIPT_PDF_DIR, { recursive: true })
}

const safe = (v) => String(v ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')

// Standard-layout PDFs are named erb-receipt_<ref>.pdf. Receipts drawn in
// the old layout were receipt_<ref>.pdf — those are left alone (and are
// regenerated in the standard layout when next opened).
export const receiptPdfPathFor = (ref) => path.join(RECEIPT_PDF_DIR, `erb-receipt_${safe(ref)}.pdf`)
const previewPath = () => path.join(RECEIPT_PDF_DIR, `preview_${crypto.randomBytes(6).toString('hex')}.pdf`)

// Gateway-inclusive amount → ERB fee (online payments are stored at what
// the payer was charged). Keep in sync with fee-schedule.js ERB_FEE_BY_CHARGED.
const ERB_FEE_MAP = {
  406100: 400000, 203050: 200000, 101560: 100000,
  1055900: 1040000, 3045700: 3000000, 761450: 750000, 609150: 600000,
  1827430: 1800000, 659920: 650000, 507650: 500000,
}
const erbFee = (amount) => { const n = Number(amount); return ERB_FEE_MAP[n] ?? n }

// How a manually issued receipt was paid (PaymentTransaction.paid_via).
export const PAID_VIA_LABEL = {
  BANK:   'Bank deposit',
  EFT:    'Bank transfer (EFT/RTGS)',
  MOBILE: 'Mobile Money',
  CASH:   'Cash',
  CHEQUE: 'Cheque',
  OTHER:  'Other',
}

const TYPE_LABEL = {
  APPLICATION:  'Application Fee',
  REGISTRATION: 'Annual Registration Fee',
  RENEWAL:      'Annual Licence Renewal Fee',
  LICENCE:      'Annual Practising Licence Fee',
  WED:          'World Engineering Day',
}
const CATEGORY_LABEL = {
  CORPORATE:    'Engineer',
  TEMPORARY:    'Temporary Engineer',
  TECHNOLOGIST: 'Engineering Technologist',
  TECHNICIAN:   'Engineering Technician',
}
const trackingNumber = (id) => (/^\d+$/.test(String(id || '')) ? `ERB-${String(id).padStart(5, '0')}` : null)
const present = (v) => v != null && String(v).trim() !== '' && String(v) !== 'null'

function methodLabel(tx) {
  if (tx.paid_via) return PAID_VIA_LABEL[String(tx.paid_via).toUpperCase()] || tx.paid_via
  const pm = String(tx.payment_method || '').toUpperCase()
  const pv = String(tx.provider || '').toUpperCase()
  if (pm === 'RECEIPT' || pv === 'RECEIPT') return 'Bank slip (verified by Accounts)'
  if (pv.includes('MTN'))    return 'Mobile Money (MTN)'
  if (pv.includes('AIRTEL')) return 'Mobile Money (Airtel)'
  if (pm === 'MOBILE')       return pv ? `Mobile Money (${tx.provider})` : 'Mobile Money'
  return tx.provider || tx.payment_method || null
}

/**
 * Application / registration / renewal fee receipt.
 * @param {object} tx  PaymentTransaction-shaped object (see receipt-controller.js)
 * @param {object} [opts]
 * @param {boolean} [opts.preview]  draw an unnumbered PREVIEW to a temp file
 * @returns {Promise<string>} path of the PDF
 */
export async function generateReceiptPdf(tx, { preview = false } = {}) {
  const purpose  = String(tx.purpose || 'APPLICATION').toUpperCase()
  const ref      = tx.transaction_ref || `TX-${tx.id || Date.now()}`
  const category = present(tx.fee_category) ? CATEGORY_LABEL[resolveFeeCategory(tx.fee_category)] : null
  const isSyntheticRef = /^ERB-\d+-ACCTVERIFIED$/.test(ref)
  const isReceiptPayment = [tx.payment_method, tx.provider].some(v => String(v || '').toUpperCase() === 'RECEIPT')

  const { receiptNo, issuedAt } = preview
    ? { receiptNo: 'PREVIEW', issuedAt: new Date() }
    : await assignReceiptNumber(`TX:${ref}`)

  const paidOn = tx.paid_on || tx.gateway_confirmed_at || tx.createdAt || tx.created_at || tx.updatedAt
  const regNo  = purpose === 'RENEWAL'
    ? (tx.registration_number || tx.application_id)
    : (present(tx.registration_number) && String(tx.registration_number) !== String(tx.application_id) ? tx.registration_number : null)

  const description = {
    APPLICATION:  `Licence Application Fee${category ? ` — ${category}` : ''}`,
    REGISTRATION: `Annual Registration Fee${category ? ` — ${category}` : ''}`,
    RENEWAL:      'Annual Practising Licence Renewal',
  }[purpose] || TYPE_LABEL[purpose] || 'ERB Payment'

  const period = purpose === 'RENEWAL'
    ? (tx.renewal_year || (paidOn ? new Date(paidOn).getFullYear() : null))
    : purpose === 'REGISTRATION' ? (paidOn ? new Date(paidOn).getFullYear() : null) : null

  const filePath = preview ? previewPath() : receiptPdfPathFor(ref)
  return renderStandardReceipt({
    receiptNo,
    issuedOn:  issuedAt,
    status:    preview ? 'PREVIEW' : 'PAID',
    typeLabel: TYPE_LABEL[purpose] || 'ERB Payment',
    name:      tx.applicant_name,
    regNo,
    appNo:     purpose === 'RENEWAL' ? null : trackingNumber(tx.application_id),
    email:     tx.email,
    method:    methodLabel(tx),
    reference: isSyntheticRef ? 'Receipt attached to application' : ref,
    paidOn,
    items:     [{ description, period, amount: erbFee(tx.amount) }],
    issuedBy:  tx.issued_by || (isReceiptPayment || tx.renewal_reviewed_by ? 'ERB Accounts' : 'ERB System'),
  }, filePath)
}

/**
 * Annual licence / WED receipt from a data.erb.go.ug paid-records row:
 * name, reg_no, license_no, specialization, email_address, purpose,
 * amount_paid, year_paid (any may be missing).
 * @param {object} record
 * @param {object} [opts]
 * @param {'LICENCE'|'WED'} [opts.kind]
 * @param {boolean} [opts.preview]  unnumbered PREVIEW
 * @returns {Promise<string>} path of the PDF
 */
export async function generateEngineerReceiptPdf(record = {}, { kind = 'LICENCE', preview = false } = {}) {
  const K = String(kind || 'LICENCE').toUpperCase() === 'WED' ? 'WED' : 'LICENCE'
  const year = record.year_paid || new Date().getFullYear()
  const email = String(record.email_address || record.email || '').split(/[;,]/)[0].trim() || null
  // Stable key so the same paid record always gets the same receipt number.
  const key = record.id != null
    ? `${K}:${record.id}`
    : `${K}:${record.reg_no || email || record.name || 'unknown'}:${year}:${record.purpose || ''}`

  const { receiptNo, issuedAt } = preview
    ? { receiptNo: 'PREVIEW', issuedAt: new Date() }
    : await assignReceiptNumber(key)

  const filePath = preview
    ? previewPath()
    : path.join(RECEIPT_PDF_DIR, `erb-receipt_${K}_${safe(record.reg_no || record.id || 'x')}_${Date.now()}.pdf`)

  return renderStandardReceipt({
    receiptNo,
    issuedOn:  issuedAt,
    status:    preview ? 'PREVIEW' : 'PAID',
    typeLabel: TYPE_LABEL[K],
    name:      record.name,
    regNo:     record.reg_no,
    licenceNo: record.license_no,
    specialization: record.specialization,
    email,
    method:    record.payment_method ? (PAID_VIA_LABEL[String(record.payment_method).toUpperCase()] || record.payment_method) : null,
    reference: record.payment_reference || record.transaction_ref || null,
    paidOn:    record.date_paid || record.paid_on || null,
    items: [{
      description: record.purpose || (K === 'WED' ? 'World Engineering Day' : `Annual and Practising Licence Fees ${year}`),
      period:      K === 'WED' ? (record.year_paid || year) : year,
      amount:      record.amount_paid,
    }],
    issuedBy: record.issued_by || 'ERB Accounts',
  }, filePath)
}
