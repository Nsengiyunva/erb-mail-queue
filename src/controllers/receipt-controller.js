import { sequelize } from '../config/database.js'
import { DataTypes, Op } from 'sequelize'
import fs             from 'fs'
import path            from 'path'
import { Application }      from '../models/index.js'
import { generateReceiptPdf } from '../utils/receipt-pdf.js'
import paymentReceiptQueue    from '../queues/payment_receipt_queue.js'
import { sendStyledMail }     from '../utils/mailer.js'

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
  // Applicant's email, captured at save time so downstream email pipelines
  // (receipts, renewal approve/reject notices) don't have to guess it back
  // out via Application lookups that may not exist for a renewal (renewals
  // aren't tied to an erb_applications row the way the initial application
  // fee is).
  email:               { type: DataTypes.STRING(200) },
  // ── Added for the accounts-reviewed renewal-payment workflow ────
  // Only meaningful for purpose = 'RENEWAL'. Every online MoMo attempt or
  // attached-receipt renewal payment starts PENDING and needs an Accounts
  // reviewer to move it to APPROVED or REJECTED — see POST
  // /renewals/:id/approve and /reject in receipt_routes.js. Deliberately
  // separate from `status` above, which continues to reflect only the
  // payment attempt's own outcome (MoMo success/failure, or "a receipt was
  // attached"), not whether Accounts has actually signed off on it.
  renewal_status:         { type: DataTypes.STRING(20) },  // null | 'PENDING' | 'APPROVED' | 'REJECTED'
  renewal_reviewed_by:    { type: DataTypes.STRING(200) },
  renewal_reviewed_at:    { type: DataTypes.DATE },
  renewal_review_comment: { type: DataTypes.TEXT },
  // ── Added for admin-initiated manual status changes on the Payment
  // Tracker (Success / Failed / Deleted) ──────────────────────────
  // Distinct from renewal_reviewed_by/at above (which is specific to the
  // renewal-approval workflow) — this covers a direct status override on
  // any transaction, of any purpose, from the Payment Tracker admin UI.
  status_changed_by:      { type: DataTypes.STRING(200) },
  status_changed_at:      { type: DataTypes.DATE },
  status_change_reason:   { type: DataTypes.TEXT },
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

// ── Accounts-verification → PDF receipt → email ─────────────────────
// Triggered by POST /accounts_verify (application_routes.js) the moment
// an Accounts-level admin confirms an applicant's payment. This is the
// one place every accounts-approved application passes through,
// regardless of how the money actually got here — so it's the right
// place to guarantee a receipt goes out, rather than relying only on
// maybeSendReceiptEmail (which only ever fires off a *system-confirmed*
// SUCCESS: a real FlexiPay callback, or the instant "Attach Receipt"
// flow — neither of which covers an application-fee receipt attached
// directly at submission time and manually checked by Accounts).
export async function sendAccountsVerificationReceipt(application) {
  if (!application) return
  const raw = typeof application.toJSON === 'function' ? application.toJSON() : application

  const email = raw.email_address
  if (!email) {
    console.error(`[accounts-verify-receipt] No email on file for application ${raw.id} — skipping receipt`)
    return
  }

  const applicantName = raw.name || [raw.first_name, raw.other_names, raw.surname].filter(Boolean).join(' ')

  // Prefer a real PaymentTransaction row (a FlexiPay attempt, or the
  // instant "Attach Receipt" flow) if one exists — it carries the actual
  // amount/provider/ref. Falls back to the application's own attached
  // receipt (payment_receipt_path) when the applicant never went through
  // either of those paths.
  const payment = await PaymentTransaction.findOne({
    where: { application_id: String(raw.id), status: { [Op.ne]: 'DELETED' } },
    order: [['updatedAt', 'DESC']],
  })

  if (payment) {
    // Accounts has now manually confirmed this payment — send the
    // standard receipt pipeline through as SUCCESS regardless of what
    // the underlying attempt's own status says (e.g. a FlexiPay attempt
    // that failed, but the applicant paid by another means Accounts
    // could verify). This does NOT rewrite payment.status itself — the
    // Payment Tracker should keep showing what actually happened to that
    // attempt; only the receipt/email pipeline is forced through here.
    if (payment.receipt_email_status === 'QUEUED' || payment.receipt_email_status === 'SENT') return
    await maybeSendReceiptEmail(
      { ...payment.toJSON(), status: 'SUCCESS', applicant_name: payment.applicant_name || applicantName },
      { email }
    )
    return
  }

  if (!raw.payment_receipt_path) {
    console.error(`[accounts-verify-receipt] No payment record or attached receipt for application ${raw.id} — skipping receipt`)
    return
  }

  if (raw.accounts_receipt_email_status === 'QUEUED' || raw.accounts_receipt_email_status === 'SENT') return

  // Claim it immediately, same reasoning as maybeSendReceiptEmail above.
  await Application.update(
    { accounts_receipt_email_status: 'QUEUED' },
    { where: { id: raw.id } }
  )

  const syntheticRef = `ERB-${raw.id}-ACCTVERIFIED`

  try {
    const filePath = await generateReceiptPdf({
      transaction_ref: syntheticRef,
      application_id:  raw.id,
      applicant_name:  applicantName,
      amount:          null, // no confirmed amount on file for a directly-attached receipt
      provider:        null,
      phone:            raw.telephone || raw.registered_phone_number || raw.provided_number,
      purpose:          'APPLICATION',
      payment_method:   'RECEIPT',
      status:           'SUCCESS',
      updatedAt:        raw.accounts_verified_at || new Date(),
    })

    await paymentReceiptQueue.add(
      'send-payment-receipt',
      {
        transactionRef: syntheticRef,
        email,
        filePath,
        applicantName,
        amount:  null,
        purpose: 'APPLICATION',
        // Tells the worker to confirm via Application.accounts_receipt_email_status
        // instead of PaymentTransaction.receipt_email_status — there's no
        // PaymentTransaction row for this one.
        applicationId: raw.id,
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }
    )
  } catch (err) {
    console.error(`[accounts-verify-receipt] Failed for application ${raw.id}:`, err.message)
    await Application.update(
      { accounts_receipt_email_status: 'FAILED' },
      { where: { id: raw.id } }
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

    // Don't clobber an existing renewal_status on a resubmitted/duplicate
    // save (e.g. a client-side retry of the exact same request) — only
    // seed it the first time a RENEWAL transaction is created.
    const existing = await PaymentTransaction.findOne({ where: { transaction_ref } })
    const resolvedRenewalStatus = resolvedPurpose === 'RENEWAL'
      ? (existing?.renewal_status || 'PENDING')
      : (existing?.renewal_status ?? null)

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
      email:          email || existing?.email || null,
      renewal_status: resolvedRenewalStatus,
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
// stores the receipt AND immediately marks the transaction SUCCESS.
//
// NOTE: `status: 'SUCCESS'` here only means "the applicant declares this
// payment complete and attached proof" — it is NOT the same as Accounts
// having verified it. Every RENEWAL-purpose transaction (this path and
// the online MoMo path in saveTransaction above) now goes through a
// separate `renewal_status` review — see POST /renewals/:id/approve and
// /reject in receipt_routes.js — before a receipt email goes out. That's
// also why this still doesn't call maybeSendReceiptEmail directly: the
// renewal-approval receipt is sent once Accounts approves, via
// sendRenewalApprovedReceipt, not automatically here.
export const submitReceiptPayment = async (req, res) => {
  try {
    const {
      applicant_id, applicant_name, phone,
      registration_number, amount, transaction_ref, email,
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
      email:               email || null,
      renewal_status:      'PENDING',
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

// ── Renewal review: email helpers ───────────────────────────────────
// Both are called from POST /renewals/:id/approve and /reject in
// receipt_routes.js, right after the renewal_status update. Neither
// blocks the HTTP response — call sites fire-and-forget these with
// .catch(), same pattern as maybeSendReceiptEmail above.

// Renewal transactions don't always carry an `email` column (older rows
// predate it, or a call site never sent one) — fall back to the same
// Application-lookup strategy saveTransaction's pipeline already uses.
async function resolveRenewalEmail(raw) {
  if (raw.email) return raw.email
  return resolveApplicantEmail({
    application_id: raw.application_id,
    applicant_id:   raw.applicant_id,
  })
}

// Approval → generate/queue the same PDF-receipt-by-email pipeline as any
// other confirmed SUCCESS payment, forced through regardless of the raw
// MoMo attempt's own status (Accounts has now manually confirmed it).
export async function sendRenewalApprovedReceipt(tx) {
  if (!tx) return
  const raw = typeof tx.toJSON === 'function' ? tx.toJSON() : tx

  const email = await resolveRenewalEmail(raw)
  if (!email) {
    console.error(`[renewal-approved-receipt] No email on file for transaction ${raw.transaction_ref} — skipping receipt`)
    return
  }

  await maybeSendReceiptEmail({ ...raw, status: 'SUCCESS', purpose: 'RENEWAL' }, { email })
}

// Rejection → a plain notice, no receipt attached (there's nothing to
// confirm). Doesn't reuse the paymentReceiptQueue/worker since there's no
// PDF and no receipt_email_status bookkeeping to do — this is a one-shot,
// best-effort notification, same spirit as the applicant-facing
// application-deferred email in application_routes.js.
export async function sendRenewalRejectedNotice(tx, reason) {
  if (!tx) return
  const raw = typeof tx.toJSON === 'function' ? tx.toJSON() : tx

  const email = await resolveRenewalEmail(raw)
  if (!email) {
    console.error(`[renewal-rejected-notice] No email on file for transaction ${raw.transaction_ref} — skipping notice`)
    return
  }

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f8f2f2; padding: 30px;">
      <div style="max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 8px;">
        <div style="background-color: #b30000; padding: 20px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 20px;">
            Engineers Registration Board (ERB)
          </h1>
        </div>
        <div style="padding: 25px;">
          <h2 style="margin-top: 0;">Dear ${raw.applicant_name || 'Engineer'},</h2>
          <p>We were unable to verify your recent licence renewal payment
             (Ref: <strong>${raw.transaction_ref || '-'}</strong>), so it has not
             been approved.</p>
          ${reason ? `<p style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:12px 14px;color:#991b1b;"><strong>Reason:</strong> ${reason}</p>` : ''}
          <p>Please review your payment details and resubmit, or contact the
             Accounts office if you believe this is in error.</p>
          <p>
            Regards,<br/>
            <strong>ERB Accounts Team</strong>
          </p>
        </div>
      </div>
    </div>
  `

  await sendStyledMail(
    email,
    `ERB Renewal Payment — Action Needed (${raw.transaction_ref || ''})`.trim(),
    html
  )
}

