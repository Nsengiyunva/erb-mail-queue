import { sequelize } from '../config/database.js'
import { DataTypes } from 'sequelize'
import fs             from 'fs'
import path            from 'path'

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
  purpose:             { type: DataTypes.STRING(50) },   // e.g. 'RENEWAL'
  payment_method:      { type: DataTypes.STRING(20) },   // 'MOBILE' | 'RECEIPT'
  registration_number: { type: DataTypes.STRING(50) },
  receipt_path:        { type: DataTypes.STRING(255) },
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

// ── Controller ────────────────────────────────────────────────────
export const saveTransaction = async (req, res) => {
  const {
    application_id, transaction_ref, phone,
    provider, amount, applicant_name, applicant_id, status,
    purpose, payment_method, registration_number,
  } = req.body

  if (!application_id || !transaction_ref) {
    return res.status(400).json({ message: 'application_id and transaction_ref are required' })
  }

  try {
    await PaymentTransaction.upsert({
      application_id,
      transaction_ref,
      phone,
      provider,
      amount,
      applicant_name,
      applicant_id,
      status: status || 'INITIATED',
      purpose,
      payment_method,
      registration_number,
    })

    res.json({ saved: true })

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