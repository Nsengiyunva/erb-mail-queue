import { sequelize } from '../config/database.js'
import { DataTypes } from 'sequelize'
import fs             from 'fs'
import path            from 'path'
import { Application }      from '../models/index.js'
import { generateReceiptPdf } from '../utils/receipt-pdf.js'
import paymentReceiptQueue    from '../queues/payment_receipt_queue.js'

// ── Model ─────────────────────────────────────────────────────────
export const PaymentTransaction = sequelize.define('PaymentTransaction', {
  id:                  { type: DataTypes.INTEGER,      autoIncrement: true, primaryKey: true },
  application_id:      { type: DataTypes.STRING(100),  allowNull: false },
  transaction_ref:     { type: DataTypes.STRING(100),  allowNull: false, unique: true },
  phone:               { type: DataTypes.STRING(20) },
  provider:            { type: DataTypes.STRING(20) },
  amount:              { type: DataTypes.INTEGER },
  applicant_name:      { type: DataTypes.STRING(200) },
  applicant_id:        { type: DataTypes.INTEGER },
  status:              { type: DataTypes.STRING(50),   defaultValue: 'INITIATED' },
  // ── Added for the instant renewal-payment flow ──────────────────
  purpose:             { type: DataTypes.STRING(50) },   // 'APPLICATION' | 'REGISTRATION' | 'RENEWAL'
  payment_method:      { type: DataTypes.STRING(20) },   // 'MOBILE' | 'RECEIPT'
  registration_number: { type: DataTypes.STRING(50) },
  receipt_path:        { type: DataTypes.STRING(255) },
  // ── Added for the SUCCESS → PDF receipt → email pipeline ────────
  // Tracks the *emailing* of the system-generated PDF receipt, separately
  // from `status` (which tracks the payment itself). payment_receipt_worker.js
  // already referenced this column before it existed here — that update
  // was silently a no-op because Sequelize doesn't write unknown
  // attributes, which is why receipts were never actually confirmed sent.
  receipt_email_status: { type: DataTypes.STRING(20) },  // null | 'QUEUED' | 'SENT' | 'FAILED'
}, {
  tableName:   'payment_transactions',
  timestamps:  true,
  underscored: true,
})

// Create the table if it doesn't exist yet, and add the new columns above
// to the existing table if it already exists (this only ever ADDS
// columns — it never drops or renames existing ones — but since it runs
// on every boot, review it once against a staging DB before your next
// deploy if you'd rather manage schema changes by hand).
PaymentTransaction.sync({ alter: true }).catch(err =>
  console.error('[PaymentTransaction] sync error:', err.message)
)

// ── Status normaliser ─────────────────────────────────────────────
export function normaliseStatus(raw) {
  if (!raw) return null
  const s = String(raw).trim().toLowerCase()
  if (['success', 'successful', 'completed', 'complete', 'paid'].includes(s)) return 'SUCCESS'
  if (['failed', 'failure', 'declined', 'cancelled', 'canceled', 'error'].includes(s)) return 'FAILED'
  if (['initiated', 'pending', 'processing'].includes(s)) return 'INITIATED'
  return s.toUpperCase()   // fall back to the raw value, upper-cased
}

// ── Resolve the applicant's email for a transaction ───────────────
// save-transaction and the payment-update webhook don't always carry an
// `email` field — the frontend call sites (SectionF/Renewal/Registration)
// only ever send applicant_id, application_id, phone, etc. `applicant_id`
// is the one field every call site sends and the one that reliably maps
// back to the same person regardless of purpose, so it's tried first;
// `application_id` is only a safe direct lookup for the APPLICATION-fee
// flow, where it IS the erb_applications.id (for REGISTRATION/RENEWAL it's
// a registration number instead, so a PK lookup on it would just miss).
async function resolveApplicantEmail({ email, application_id, applicant_id }) {
  if (email) return email

  if (applicant_id) {
    const byApplicant = await Application.findOne({
      where: { applicant_id },
      order: [['updated_at', 'DESC']],
    })
    if (byApplicant?.email_address) return byApplicant.email_address
  }

  if (application_id && /^\d+$/.test(String(application_id))) {
    const byId = await Application.findByPk(application_id)
    if (byId?.email_address) return byId.email_address
  }

  return null
}

// ── SUCCESS → generate PDF receipt → queue email ───────────────────
// Shared by saveTransaction (below) and the /payment-update webhook in
// index.js, which is the actual trigger for a real Mobile Money payment
// (called by the VM1 payment watcher once it sees the confirmation SMS —
// see the screenshot format this was built against). Safe to call for
// any transaction in any state: it only acts when normalised status is
// SUCCESS, and receipt_email_status guards against sending the same
// receipt twice (e.g. a retried webhook, or saveTransaction and the
// webhook both firing for the same transaction_ref).
export async function maybeSendReceiptEmail(record, { email } = {}) {
  if (!record) return
  const tx = typeof record.toJSON === 'function' ? record.toJSON() : record

  if (normaliseStatus(tx.status) !== 'SUCCESS') return
  if (tx.receipt_email_status === 'QUEUED' || tx.receipt_email_status === 'SENT') return

  // Claim it immediately so a near-simultaneous duplicate call (e.g.
  // saveTransaction and the payment-update webhook both firing for the
  // same transaction_ref) can't also pass the check above and double-send.
  await PaymentTransaction.update(
    { receipt_email_status: 'QUEUED' },
    { where: { transaction_ref: tx.transaction_ref } }
  )

  try {
    const resolvedEmail = await resolveApplicantEmail({
      email,
      application_id: tx.application_id,
      applicant_id:   tx.applicant_id,
    })

    if (!resolvedEmail) {
      console.error(`[receipt-pipeline] No email on file for transaction ${tx.transaction_ref} — skipping receipt`)
      await PaymentTransaction.update(
        { receipt_email_status: 'FAILED' },
        { where: { transaction_ref: tx.transaction_ref } }
      )
      return
    }

    const filePath = await generateReceiptPdf({
      ...tx,
      purpose: tx.purpose || 'APPLICATION',
    })

    await paymentReceiptQueue.add(
      'send-payment-receipt',
      {
        transactionRef: tx.transaction_ref,
        email:          resolvedEmail,
        filePath,
        applicantName:  tx.applicant_name,
        amount:         tx.amount,
        purpose:        tx.purpose || 'APPLICATION',
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }
    )

  } catch (err) {
    console.error(`[receipt-pipeline] Failed for transaction ${tx.transaction_ref}:`, err.message)
    await PaymentTransaction.update(
      { receipt_email_status: 'FAILED' },
      { where: { transaction_ref: tx.transaction_ref } }
    ).catch(() => {})
  }
}

// ── Controller ────────────────────────────────────────────────────
export const saveTransaction = async (req, res) => {
  const {
    application_id, transaction_ref, phone,
    provider, amount, applicant_name, applicant_id, status,
    purpose, payment_method, registration_number, email,
  } = req.body

  if (!application_id || !transaction_ref) {
    return res.status(400).json({ message: 'application_id and transaction_ref are required' })
  }

  try {
    // Application fee payments (SectionF.js, submitted at application
    // time) are the one call site that never sends `purpose` — default
    // it here so their receipts render "Application Fee" instead of the
    // generic fallback.
    const resolvedPurpose = purpose || 'APPLICATION'

    const [record] = await PaymentTransaction.upsert({
      application_id,
      transaction_ref,
      phone,
      provider,
      amount,
      applicant_name,
      applicant_id,
      status: status || 'INITIATED',
      purpose: resolvedPurpose,
      payment_method,
      registration_number,
    })

    res.json({ saved: true })

    // Best-effort, non-blocking — the response above has already gone
    // out, so any failure here is only ever logged, never surfaced as an
    // API error to the caller.
    maybeSendReceiptEmail(record, { email }).catch(err =>
      console.error('[save-transaction] receipt pipeline failed:', err.message)
    )

  } catch (err) {
    console.error('[save-transaction]', err.message)
    res.status(500).json({ message: 'Failed to save transaction' })
  }
}

// ── POST /renewal-payment ────────────────────────────────────────
// One-shot "instant payment" endpoint for the Renewal screen's
// "Attach Receipt" path: the frontend only calls this once the user
// clicks the final Submit button (not on file-select), so this both
// stores the receipt AND immediately marks the transaction SUCCESS —
// there is no separate pending-review step for this path, per the
// product decision that an attached receipt is itself the applicant's
// declaration of a completed payment.
//
// NOTE: this deliberately does NOT trigger maybeSendReceiptEmail. The
// "receipt" here is a file the applicant uploaded themselves (their own
// proof of an offline payment) — not a payment this system confirmed and
// generated an official PDF for. Wiring that in would mean emailing the
// applicant back the exact file they just gave us, which isn't useful.
export const submitReceiptPayment = async (req, res) => {
  try {
    const {
      applicant_id, applicant_name, phone,
      registration_number, amount, transaction_ref,
    } = req.body

    if (!req.file) {
      return res.status(400).json({ message: 'A receipt file is required' })
    }
    if (!applicant_id || !registration_number) {
      fs.unlink(req.file.path, () => {})
      return res.status(400).json({ message: 'applicant_id and registration_number are required' })
    }

    const receiptPath = path.basename(req.file.path)
    const ref = transaction_ref || `RENEWAL-RCPT-${Date.now()}-${applicant_id}`

    const [ record ] = await PaymentTransaction.upsert({
      application_id:      registration_number,
      transaction_ref:     ref,
      phone,
      provider:            'RECEIPT',
      amount:              amount ? parseInt(amount, 10) : null,
      applicant_name,
      applicant_id:        parseInt(applicant_id, 10),
      status:              'SUCCESS',
      purpose:             'RENEWAL',
      payment_method:      'RECEIPT',
      registration_number,
      receipt_path:        receiptPath,
    })

    return res.status(201).json({
      message:         'Payment recorded successfully',
      transaction_ref: ref,
      receipt_path:    receiptPath,
      id:              record?.id,
    })

  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {})
    console.error('[renewal-payment]', err.message)
    return res.status(500).json({ message: 'Failed to record renewal payment' })
  }
}
