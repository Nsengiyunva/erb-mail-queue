import { sequelize } from '../config/database.js'
import { DataTypes } from 'sequelize'

// ── Model ─────────────────────────────────────────────────────────
export const PaymentTransaction = sequelize.define('PaymentTransaction', {
  id:              { type: DataTypes.INTEGER,      autoIncrement: true, primaryKey: true },
  application_id:  { type: DataTypes.STRING(100),  allowNull: false },
  transaction_ref: { type: DataTypes.STRING(100),  allowNull: false, unique: true },
  phone:           { type: DataTypes.STRING(20) },
  provider:        { type: DataTypes.STRING(20) },
  amount:          { type: DataTypes.INTEGER },
  applicant_name:  { type: DataTypes.STRING(200) },
  applicant_id:    { type: DataTypes.INTEGER },
  status:          { type: DataTypes.STRING(50),   defaultValue: 'INITIATED' },
}, {
  tableName:   'payment_transactions',
  timestamps:  true,
  underscored: true,
})

// Create the table if it doesn't exist yet (safe — won't drop existing data)
PaymentTransaction.sync({ alter: false }).catch(err =>
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
    })

    res.json({ saved: true })

  } catch (err) {
    console.error('[save-transaction]', err.message)
    res.status(500).json({ message: 'Failed to save transaction' })
  }
}