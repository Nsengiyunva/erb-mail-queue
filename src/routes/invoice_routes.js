import express       from 'express'
import multer        from 'multer'
import fs             from 'fs'
import cors           from 'cors'
import { Op }          from 'sequelize'
import { sequelize }  from '../config/database.js'
import InvoiceModel   from '../models/Invoice.js'
import { DataTypes }  from 'sequelize'
import invoiceQueue   from '../queues/invoice_queue.js'

const router  = express.Router()
const Invoice = InvoiceModel(sequelize, DataTypes)

Invoice.sync({ alter: false }).catch(err =>
  console.error('[Invoice] sync error:', err.message)
)

const FILE_DIR = '/home/user1/ERB/uploads'

if (!fs.existsSync(FILE_DIR)) {
  fs.mkdirSync(FILE_DIR, { recursive: true })
}

// ── CORS ──────────────────────────────────────────────────────────
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'https://registration.erb.go.ug',
    'https://data.erb.go.ug',
    'https://erb.go.ug',
    'https://mis.nec.go.ug',
  ],
  credentials: true,
}

router.use(cors(corsOptions))
router.options(/.*/, cors(corsOptions))

// ── Multer ────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FILE_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_')
    cb(null, `invoice-${Date.now()}_${safe}`)
  },
})

const upload = multer({ storage })

// ── Shared derived-totals calculation ────────────────────────────
// Mirrors the frontend's computeInvoiceTotals() exactly — recomputed
// server-side rather than trusted from the client, so a saved record
// always reflects a consistent calculation.
const computeTotals = (body) => {
  const engineers    = Number(body.annual_fee_engineers) || 0
  const rate          = Number(body.annual_fee_rate) || 0
  const arrears        = Number(body.arrears_amount) || 0
  const surchargePct   = Number(body.surcharge_percent) || 0

  const annual_fee_amount = engineers * rate
  const surcharge_amount  = Math.round(arrears * (surchargePct / 100))
  const total_amount      = annual_fee_amount + arrears + surcharge_amount

  return { annual_fee_amount, surcharge_amount, total_amount }
}

const buildInvoicePayload = (body) => {
  const { annual_fee_amount, surcharge_amount, total_amount } = computeTotals(body)

  return {
    invoice_no:            body.invoice_no,
    invoice_date:          body.invoice_date,
    engineer_name:         body.engineer_name,
    erb_no:                body.erb_no,
    address:               body.address,
    email:                 body.email,
    financial_year:        body.financial_year,
    arrears_year:          body.arrears_year,
    annual_fee_engineers:  Number(body.annual_fee_engineers) || 0,
    annual_fee_rate:       Number(body.annual_fee_rate) || 0,
    arrears_amount:        Number(body.arrears_amount) || 0,
    surcharge_percent:     Number(body.surcharge_percent) || 0,
    annual_fee_amount,
    surcharge_amount,
    total_amount,
  }
}

// ── POST / — save invoice record only (no email) ────────────────
router.post('/', async (req, res) => {
  try {
    if (!req.body?.engineer_name || !req.body?.invoice_no) {
      return res.status(400).json({ message: 'invoice_no and engineer_name are required' })
    }

    const invoice = await Invoice.create({
      ...buildInvoicePayload(req.body),
      status: 'saved',
    })

    res.status(201).json({ message: 'Invoice saved successfully', invoice })
  } catch (error) {
    console.error('Invoice save failed:', error)
    res.status(500).json({ message: 'Failed to save invoice' })
  }
})

// ── PUT /:id — update a saved invoice record ─────────────────────
router.put('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findByPk(req.params.id)
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' })

    await invoice.update(buildInvoicePayload(req.body))
    res.json({ message: 'Invoice updated successfully', invoice })
  } catch (error) {
    console.error('Invoice update failed:', error)
    res.status(500).json({ message: 'Failed to update invoice' })
  }
})

// ── GET / — list invoices (paginated, searchable) ────────────────
router.get('/', async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const offset = (page - 1) * limit

    const where = {}
    if (req.query.search) {
      const term = `%${req.query.search}%`
      where[Op.or] = [
        { engineer_name: { [Op.like]: term } },
        { erb_no:         { [Op.like]: term } },
        { invoice_no:      { [Op.like]: term } },
      ]
    }
    if (req.query.status) {
      where.status = req.query.status
    }

    const { rows, count } = await Invoice.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit,
      offset,
    })

    res.json({
      data: rows,
      pagination: {
        page, limit,
        totalRecords: count,
        totalPages: Math.ceil(count / limit),
      },
    })
  } catch (error) {
    console.error('Invoice list failed:', error)
    res.status(500).json({ message: 'Failed to fetch invoices' })
  }
})

// ── GET /:id — get one invoice ────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findByPk(req.params.id)
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' })
    res.json({ data: invoice })
  } catch (error) {
    console.error('Invoice fetch failed:', error)
    res.status(500).json({ message: 'Failed to fetch invoice' })
  }
})

// ── OPTIONS ───────────────────────────────────────────────────────
router.options('/send-invoice', cors(corsOptions), (_req, res) => res.sendStatus(204))
router.options('/:id/resend', cors(corsOptions), (_req, res) => res.sendStatus(204))

// ── POST /:id/resend — requeue an existing invoice email (e.g. after a failure) ──
router.post('/:id/resend', async (req, res) => {
  try {
    const invoice = await Invoice.findByPk(req.params.id)
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' })

    if (!invoice.email) {
      return res.status(400).json({ message: 'This invoice has no email address on file' })
    }
    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(400).json({
        message: 'The original invoice PDF is no longer available on the server. Please regenerate and send the invoice again.',
      })
    }

    await invoice.update({ status: 'pending' })

    await invoiceQueue.add('send-invoice',
      {
        invoiceId:     invoice.id,
        email:         invoice.email,
        filePath:      invoice.file_path,
        originalName:  invoice.original_name,
        invoiceNo:     invoice.invoice_no,
        engineerName:  invoice.engineer_name,
        financialYear: invoice.financial_year,
        totalAmount:   invoice.total_amount,
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }
    )

    res.json({ message: 'Invoice queued for resending', invoice })
  } catch (error) {
    console.error('Invoice resend failed:', error)
    res.status(500).json({ message: 'Failed to resend invoice' })
  }
})

// ── POST /send-invoice — upload PDF + email it to the engineer ───
router.post('/send-invoice', upload.single('file'), async (req, res) => {
  const tx = await sequelize.transaction()
  try {
    const { email } = req.body
    const file = req.file

    if (!email || !file) {
      if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path)
      return res.status(400).json({ message: 'Email and invoice file are required' })
    }

    const payload = buildInvoicePayload(req.body)

    let invoice
    if (req.body.invoice_id) {
      invoice = await Invoice.findByPk(req.body.invoice_id, { transaction: tx })
    }

    const fields = {
      ...payload,
      file_name:      file.filename,
      original_name:  file.originalname,
      file_path:      file.path,
      status:         'pending',
    }

    if (invoice) {
      await invoice.update(fields, { transaction: tx })
    } else {
      invoice = await Invoice.create(fields, { transaction: tx })
    }

    await invoiceQueue.add('send-invoice',
      {
        invoiceId:     invoice.id,
        email,
        filePath:      invoice.file_path,
        originalName:  invoice.original_name,
        invoiceNo:     invoice.invoice_no,
        engineerName:  invoice.engineer_name,
        financialYear: invoice.financial_year,
        totalAmount:   invoice.total_amount,
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }
    )

    await tx.commit()
    res.status(201).json({ message: 'Invoice uploaded and queued for sending', invoiceId: invoice.id })

  } catch (error) {
    await tx.rollback()
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path)
    console.error('Invoice send failed:', error)
    res.status(500).json({ message: 'Failed to send invoice' })
  }
})

export default router
