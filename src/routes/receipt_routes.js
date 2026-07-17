import express       from 'express'
import multer        from 'multer'
import fs            from 'fs'
import cors          from 'cors'
import { sequelize } from '../config/database.js'
import ReceiptModel  from '../models/Receipt.js'
import { DataTypes } from 'sequelize'
import receiptQueue  from '../queues/receipt_queue.js'

import { saveTransaction, PaymentTransaction } from '../controllers/receipt-controller.js'

const router  = express.Router()
const Receipt = ReceiptModel(sequelize, DataTypes)

const FILE_DIR = '/home/user1/ERB/uploads'

if (!fs.existsSync(FILE_DIR)) {
  fs.mkdirSync(FILE_DIR, { recursive: true })
}

// ── CORS ──────────────────────────────────────────────────────────
const corsOptions = {
  origin: ['http://localhost:3000', 'https://registration.erb.go.ug'],
  credentials: true,
}

router.use(cors(corsOptions))
router.options(/.*/, cors(corsOptions))

// ── Multer ────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FILE_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_')
    cb(null, `${Date.now()}_${safe}`)
  },
})

const storage_receipt = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FILE_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_')
    cb(null, `wed-${Date.now()}_${safe}`)
  },
})

const upload         = multer({ storage })
const upload_receipt = multer({ storage: storage_receipt })

// ── OPTIONS ───────────────────────────────────────────────────────
router.options('/upload-receipt',     cors(corsOptions), (_req, res) => res.sendStatus(204))
router.options('/upload-wed-receipt', cors(corsOptions), (_req, res) => res.sendStatus(204))

// ── POST /upload-receipt ──────────────────────────────────────────
router.post('/upload-receipt', upload.single('file'), async (req, res) => {
  const tx = await sequelize.transaction()
  try {
    const { email } = req.body
    const file = req.file
    if (!email || !file)
      return res.status(400).json({ message: 'Email and file are required' })

    const receipt = await Receipt.create(
      { email, file_name: file.filename, original_name: file.originalname, file_path: file.path, status: 'pending' },
      { transaction: tx }
    )

    await receiptQueue.add('send-receipt',
      { receiptId: receipt.id, email: receipt.email, filePath: receipt.file_path, originalName: receipt.original_name },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }
    )

    await tx.commit()
    res.status(201).json({ message: 'Receipt uploaded and queued successfully', receiptId: receipt.id })

  } catch (error) {
    await tx.rollback()
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path)
    console.error('Receipt upload failed:', error)
    res.status(500).json({ message: 'Failed to upload receipt' })
  }
})

// ── POST /upload-wed-receipt ──────────────────────────────────────
router.post('/upload-wed-receipt', upload_receipt.single('file'), async (req, res) => {
  const tx = await sequelize.transaction()
  try {
    const { email } = req.body
    const file = req.file
    if (!email || !file)
      return res.status(400).json({ message: 'Email and file are required' })

    const receipt = await Receipt.create(
      { email, file_name: file.filename, original_name: file.originalname, file_path: file.path, status: 'pending' },
      { transaction: tx }
    )

    await receiptQueue.add('send-receipt',
      { receiptId: receipt.id, email: receipt.email, filePath: receipt.file_path, originalName: receipt.original_name },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }
    )

    await tx.commit()
    res.status(201).json({ message: 'WED Receipt uploaded and queued successfully', receiptId: receipt.id })

  } catch (error) {
    await tx.rollback()
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path)
    console.error('WED receipt upload failed:', error)
    res.status(500).json({ message: 'Failed to upload receipt' })
  }
})

router.post('/save-transaction', saveTransaction)

// ── GET /transactions ─────────────────────────────────────────────
// Admin: returns all transactions (most recent first, paginated).
// Applicant: returns only their own rows (filtered by applicant_id).
router.get('/transactions', async (req, res) => {
  try {
    const { Op, fn, col, where: wh } = await import('sequelize').then(m => m)
    const role        = (req.headers['x-user-role']  || '').toUpperCase()
    const applicantId = req.headers['x-applicant-id'] || null

    const isAdmin = ['REGISTRAR', 'CHAIRMAN', 'ACCOUNTS', 'REGISTRATION'].includes(role)

    const whereClause = isAdmin
      ? {}
      : applicantId
        ? { applicant_id: parseInt(applicantId, 10) }
        : { applicant_id: -1 } // returns nothing if no id passed as non-admin

    const rows = await PaymentTransaction.findAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
      limit: 200,
    })

    return res.json({ transactions: rows })
  } catch (err) {
    console.error('[GET /transactions]', err.message)
    return res.status(500).json({ message: 'Failed to fetch transactions' })
  }
})

// ── POST /transactions/:id/retry ──────────────────────────────────
// Resets a FAILED transaction back to INITIATED so the user can retry
// payment. Does NOT re-initiate the MoMo push — the frontend will call
// the forest API again. Just clears the failed status on the tracker.
router.post('/transactions/:id/retry', async (req, res) => {
  try {
    const { id } = req.params
    const tx = await PaymentTransaction.findByPk(id)
    if (!tx) return res.status(404).json({ message: 'Transaction not found' })
    if (tx.status === 'SUCCESS')
      return res.status(400).json({ message: 'Transaction already succeeded — no retry needed' })
    await tx.update({ status: 'INITIATED' })
    return res.json({ message: 'Transaction reset to INITIATED', id })
  } catch (err) {
    console.error('[POST /transactions/retry]', err.message)
    return res.status(500).json({ message: 'Failed to reset transaction' })
  }
})

export default router