import express       from 'express'
import multer        from 'multer'
import fs            from 'fs'
import path          from 'path'
import cors          from 'cors'
import { sequelize } from '../config/database.js'
import ReceiptModel  from '../models/Receipt.js'
import { DataTypes } from 'sequelize'
import receiptQueue  from '../queues/receipt_queue.js'

import { saveTransaction, submitReceiptPayment, PaymentTransaction } from '../controllers/receipt-controller.js'
import { parseReceiptWorkbook }        from '../utils/receipt-excel.js'
import { generateEngineerReceiptPdf }  from '../utils/receipt-pdf.js'

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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-role', 'x-applicant-id'],
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

const storage_excel = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FILE_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_')
    cb(null, `bulk-receipts-${Date.now()}_${safe}`)
  },
})

const upload_excel = multer({
  storage: storage_excel,
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname)
    cb(ok ? null : new Error('Only .xlsx, .xls or .csv files are accepted'), ok)
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
})

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

// ── POST /renewal-payment ─────────────────────────────────────────
// Instant-payment endpoint for the "Attach Receipt" option on the
// Renewal Payment screen. Multipart: field name is "receipt". The
// frontend only calls this once, on the final Submit click, with the
// receipt file plus the applicant's details — see submitReceiptPayment
// in receipt-controller.js for why this marks the transaction SUCCESS
// immediately rather than leaving it pending review.
router.options('/renewal-payment', cors(corsOptions), (_req, res) => res.sendStatus(204))
router.post('/renewal-payment', upload.single('receipt'), submitReceiptPayment)

// ── GET /transactions ─────────────────────────────────────────────
// Admin: returns all transactions (most recent first, paginated).
// Applicant: returns only their own rows (filtered by applicant_id).
router.get('/transactions', async (req, res) => {
  try {
    const role        = (req.headers['x-user-role']  || '').toUpperCase()
    const applicantId = req.headers['x-applicant-id'] || null

    const ADMIN_ROLES = ['REGISTRAR', 'CHAIRMAN', 'ACCOUNTS', 'REGISTRATION']
    const isAdmin     = ADMIN_ROLES.includes(role)

    const whereClause = isAdmin
      ? {}
      : { applicant_id: parseInt(applicantId, 10) || -1 }

    const rows = await PaymentTransaction.findAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
      limit: 500,
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

// ── Bulk receipt upload (Excel) ─────────────────────────────────────
// Admin uploads an .xlsx/.xls/.csv with columns: Engineer Name,
// Registration Number, Email, Specialization, Amount. Flow:
//   1. Parse + structurally validate every row (required fields,
//      email format, amount > 0, no reg_no repeated within the file).
//      If ANY row fails, nothing is inserted — the whole file is
//      rejected with a full list of what's wrong, so it can be fixed
//      and re-uploaded as one clean batch.
//   2. Check each reg_no against the existing paid-records API for a
//      receipt already on file for the current year. Any hit blocks
//      the whole batch the same way.
//   3. Only once every row is clean: insert each row via the same
//      addpaid API the single "Add New Receipt" form uses, generate
//      a receipt PDF, and enqueue it on the existing receipt email
//      queue/worker.
const DATA_API_BASE = 'https://data.erb.go.ug/api/engineers'
const DEFAULT_PURPOSE = 'Annual and Practicing Licence Fees Payment'

// Small helper to cap how many requests run at once against
// data.erb.go.ug, rather than firing the whole file's worth at once.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

// data.erb.go.ug's GET /paid-records only supports a fuzzy `search`
// param (LIKE %search% across name/email/reg_no/specialization/license_no)
// and ignores any `limit` sent — its page size is hardcoded to 10 server
// side. So a search for one reg_no can still return several unrelated
// rows (e.g. "120" also matches "1209", or a name/email containing "120"),
// and a real match can land past the first page. To get a reliable
// exact-match duplicate check we walk pages of that fuzzy result set,
// filtering for an exact reg_no + year match, up to a sane page cap.
const MAX_DUP_CHECK_PAGES = 20

async function findExistingPaidRecord(regNo, year, authHeader) {
  const target = String(regNo).trim()

  for (let page = 1; page <= MAX_DUP_CHECK_PAGES; page++) {
    const url = `${DATA_API_BASE}/paid-records?${new URLSearchParams({ search: target, page: String(page) })}`
    const res = await fetch(url, {
      headers: authHeader ? { Authorization: authHeader } : {},
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`paid-records lookup failed (${res.status})`)
    const body = await res.json()
    const records = body?.data ?? []

    const match = records.find(r => String(r.reg_no ?? '').trim() === target && Number(r.year_paid) === Number(year))
    if (match) return match

    const totalPages = body?.pagination?.totalPages ?? 1
    if (page >= totalPages) return null
  }

  return null
}

async function insertPaidRecord(row, year, authHeader) {
  const payload = {
    data: {
      reg_no:          row.reg_no,
      name:            row.name,
      specialization:  row.specialization,
      email_address:   row.email,
      amount_paid:     row.amount_paid,
      year_paid:       year,
      purpose:         row.purpose || `${DEFAULT_PURPOSE} FY ${year}`,
      license_no:      `${row.reg_no}/${year}`,
      license_status:  'SIGNED',
      email_status:    'EMAIL SENT',
      record_type:     'NEW_RECEIPT',
    },
  }

  const res = await fetch(`${DATA_API_BASE}/addpaid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  })

  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.message || `Failed to save record (${res.status})`)
  return body?.data || { ...row, ...payload.data }
}

async function generateAndQueueReceipt(engineerRecord) {
  const filePath = await generateEngineerReceiptPdf(engineerRecord)
  const originalName = `Receipt-${engineerRecord.reg_no || Date.now()}.pdf`

  const receipt = await Receipt.create({
    email:         engineerRecord.email_address,
    file_name:     path.basename(filePath),
    original_name: originalName,
    file_path:     filePath,
    status:        'pending',
  })

  await receiptQueue.add('send-receipt',
    { receiptId: receipt.id, email: receipt.email, filePath: receipt.file_path, originalName: receipt.original_name },
    { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }
  )

  return { receiptId: receipt.id }
}

router.options('/bulk-upload', cors(corsOptions), (_req, res) => res.sendStatus(204))

router.post('/bulk-upload', upload_excel.single('file'), async (req, res) => {
  const authHeader = req.headers.authorization

  try {
    if (!req.file) return res.status(400).json({ message: 'An Excel (.xlsx/.xls/.csv) file is required' })

    // 1) Parse + structural validation
    const { rows, errors: structuralErrors } = parseReceiptWorkbook(req.file.path)

    if (rows.length === 0) {
      return res.status(422).json({ message: 'No usable rows were found in the uploaded file' })
    }
    if (structuralErrors.length) {
      return res.status(422).json({
        message: `${structuralErrors.length} row(s) failed validation — nothing was inserted. Fix these and re-upload.`,
        errors: structuralErrors,
      })
    }

    // 2) Duplicate-against-database check (same reg_no + current year)
    const year = new Date().getFullYear()
    const dupChecks = await mapWithConcurrency(rows, 5, async (row) => {
      try {
        const existing = await findExistingPaidRecord(row.reg_no, year, authHeader)
        return existing ? { row: row._rowNumber, name: row.name, reg_no: row.reg_no, errors: [`A receipt for reg_no ${row.reg_no} already exists for ${year}`] } : null
      } catch (err) {
        return { row: row._rowNumber, name: row.name, reg_no: row.reg_no, errors: [`Could not verify against existing records: ${err.message}`] }
      }
    })
    const dbErrors = dupChecks.filter(Boolean)

    if (dbErrors.length) {
      return res.status(422).json({
        message: `${dbErrors.length} row(s) already have a receipt on file for ${year} — nothing was inserted.`,
        errors: dbErrors,
      })
    }

    // 3) Every row is clean — insert, generate PDF, queue the email
    const inserted = []
    const failed = []

    for (const row of rows) {
      try {
        const engineerRecord = await insertPaidRecord(row, year, authHeader)
        const { receiptId } = await generateAndQueueReceipt(engineerRecord)
        inserted.push({ row: row._rowNumber, name: row.name, reg_no: row.reg_no, receiptId })
      } catch (err) {
        failed.push({ row: row._rowNumber, name: row.name, reg_no: row.reg_no, message: err.message })
      }
    }

    res.status(201).json({
      message: `${inserted.length} receipt(s) saved and queued for sending` + (failed.length ? `, ${failed.length} row(s) failed after validation passed` : ''),
      inserted,
      failed,
    })
  } catch (error) {
    console.error('Bulk receipt upload failed:', error)
    res.status(500).json({ message: 'Failed to process the uploaded file' })
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path)
  }
})

export default router