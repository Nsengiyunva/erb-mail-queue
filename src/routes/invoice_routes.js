import express       from 'express'
import multer        from 'multer'
import fs             from 'fs'
import cors           from 'cors'
import { Op, QueryTypes } from 'sequelize'
import { sequelize }  from '../config/database.js'
import InvoiceModel   from '../models/Invoice.js'
import { DataTypes }  from 'sequelize'
import invoiceQueue   from '../queues/invoice_queue.js'
import {
  MAX_BULK_ROWS, parseSpreadsheet, validateBatch, buildTemplate,
  defaultBatchSettings, newBatchId,
} from '../utils/bulk-invoice.js'

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

// Bulk spreadsheets are parsed in memory and never written to disk.
const bulkUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(csv|xlsx|xls)$/i.test(file.originalname)) return cb(null, true)
    cb(new Error('Only .csv, .xlsx or .xls files are allowed'))
  },
})

// Same options for every invoice email job (single, resend, bulk).
// Keep recent history in Redis so the Email Queue monitor can show it
// (removeOnComplete: true deleted every job the moment it succeeded).
const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000, age: 7 * 24 * 3600 },
  removeOnFail:     { count: 5000, age: 30 * 24 * 3600 },
}

const queueInvoiceEmail = (invoice) => invoiceQueue.add('send-invoice', {
  invoiceId:     invoice.id,
  email:         invoice.email,
  filePath:      invoice.file_path,
  originalName:  invoice.original_name,
  invoiceNo:     invoice.invoice_no,
  engineerName:  invoice.engineer_name,
  financialYear: invoice.financial_year,
  totalAmount:   invoice.total_amount,
}, JOB_OPTS)

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
    if (req.query.batch_id) {
      where.batch_id = req.query.batch_id
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


// ══════════════════════════════════════════════════════════════════
//  TRACKER + QUEUE MONITOR
//  GET  /stats                 → status totals + sent/failed per day
//  POST /resend-failed         → re-queue every failed invoice
//  GET  /queue                 → live BullMQ snapshot (counts, jobs, workers)
//  POST /queue/pause|resume    → hold / release the invoice queue
//  POST /queue/retry-failed    → retry BullMQ's own failed jobs
//  These MUST stay above the `/:id` routes or Express matches them as ids.
// ══════════════════════════════════════════════════════════════════

// Invoice timestamps are stored in UTC by Sequelize; bucket days in EAT.
const TZ = '+03:00'
const LOCAL_NOW = `CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '${TZ}')`
const toInt = (v) => Number(v) || 0

// ── GET /stats?days=30 ───────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365)
    const sentLocal    = `CONVERT_TZ(sent_at, '+00:00', '${TZ}')`
    const updatedLocal = `CONVERT_TZ(updated_at, '+00:00', '${TZ}')`

    const [totals] = await sequelize.query(
      `SELECT
         COUNT(*)                                                                    AS total,
         COALESCE(SUM(status = 'sent'), 0)                                           AS sent,
         COALESCE(SUM(status = 'failed'), 0)                                         AS failed,
         COALESCE(SUM(status = 'pending'), 0)                                        AS pending,
         COALESCE(SUM(status = 'saved'), 0)                                          AS saved,
         COALESCE(SUM(status = 'sent' AND DATE(${sentLocal}) = DATE(${LOCAL_NOW})), 0)                      AS sent_today,
         COALESCE(SUM(status = 'sent' AND DATE(${sentLocal}) >= DATE(${LOCAL_NOW}) - INTERVAL 6 DAY), 0)    AS sent_week,
         COALESCE(SUM(status = 'sent' AND DATE(${sentLocal}) >= DATE(${LOCAL_NOW}) - INTERVAL 29 DAY), 0)   AS sent_month,
         COALESCE(SUM(status = 'pending' AND updated_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE), 0)        AS stuck_pending
       FROM erb_invoices`,
      { type: QueryTypes.SELECT }
    )

    const [sentDaily, failedDaily] = await Promise.all([
      sequelize.query(
        `SELECT DATE_FORMAT(${sentLocal}, '%Y-%m-%d') AS day, COUNT(*) AS n
           FROM erb_invoices
          WHERE status = 'sent' AND sent_at IS NOT NULL
            AND DATE(${sentLocal}) >= DATE(${LOCAL_NOW}) - INTERVAL :d DAY
          GROUP BY day`,
        { type: QueryTypes.SELECT, replacements: { d: days - 1 } }
      ),
      sequelize.query(
        `SELECT DATE_FORMAT(${updatedLocal}, '%Y-%m-%d') AS day, COUNT(*) AS n
           FROM erb_invoices
          WHERE status = 'failed'
            AND DATE(${updatedLocal}) >= DATE(${LOCAL_NOW}) - INTERVAL :d DAY
          GROUP BY day`,
        { type: QueryTypes.SELECT, replacements: { d: days - 1 } }
      ),
    ])

    const byDay = {}
    for (const r of sentDaily)   byDay[r.day] = { date: r.day, sent: toInt(r.n), failed: 0 }
    for (const r of failedDaily) {
      byDay[r.day] = byDay[r.day] || { date: r.day, sent: 0, failed: 0 }
      byDay[r.day].failed = toInt(r.n)
    }

    res.json({
      days,
      totals: {
        total:   toInt(totals.total),
        sent:    toInt(totals.sent),
        failed:  toInt(totals.failed),
        pending: toInt(totals.pending),
        saved:   toInt(totals.saved),
      },
      sent_today:    toInt(totals.sent_today),
      sent_week:     toInt(totals.sent_week),
      sent_month:    toInt(totals.sent_month),
      stuck_pending: toInt(totals.stuck_pending),
      daily: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
    })
  } catch (error) {
    console.error('Invoice stats failed:', error)
    res.status(500).json({ message: 'Failed to load invoice stats' })
  }
})

// ── POST /resend-failed  body: { batch_id?, includeStuck? } ──────
// Uses the same queueInvoiceEmail() as single resend, so the worker
// gets the full payload (email, filePath, …) it expects.
router.post('/resend-failed', async (req, res) => {
  try {
    const { batch_id, includeStuck } = req.body || {}

    const statusWhere = includeStuck
      ? { [Op.or]: [
          { status: 'failed' },
          { status: 'pending', updated_at: { [Op.lt]: new Date(Date.now() - 30 * 60 * 1000) } },
        ] }
      : { status: 'failed' }

    const invoices = await Invoice.findAll({
      where: { ...statusWhere, ...(batch_id ? { batch_id } : {}) },
      order: [['id', 'ASC']],
    })

    const queued = []
    const skipped = []
    for (const invoice of invoices) {
      if (!invoice.email) { skipped.push({ id: invoice.id, reason: 'No email address' }); continue }
      if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
        skipped.push({ id: invoice.id, reason: 'PDF no longer on server — regenerate and send' })
        continue
      }
      await invoice.update({ status: 'pending', send_error: null })
      await queueInvoiceEmail(invoice)
      queued.push(invoice.id)
    }

    res.json({
      queued: queued.length,
      skipped: skipped.length,
      skippedDetails: skipped,
      message: queued.length
        ? `Queued ${queued.length} invoice(s) for resending${skipped.length ? `, skipped ${skipped.length}` : ''}`
        : skipped.length ? `Nothing queued — ${skipped.length} invoice(s) could not be resent` : 'No failed invoices to resend',
    })
  } catch (error) {
    console.error('Resend failed invoices failed:', error)
    res.status(500).json({ message: 'Failed to queue failed invoices' })
  }
})

// ── GET /queue — live snapshot for the Email Queue monitor ───────
const serializeJob = (job, state) => ({
  id:           job.id,
  name:         job.name,
  state,
  invoiceId:    job.data?.invoiceId ?? null,
  attemptsMade: job.attemptsMade,
  attempts:     job.opts?.attempts || 1,
  progress:     job.progress,
  failedReason: job.failedReason || null,
  createdAt:    job.timestamp || null,
  processedOn:  job.processedOn || null,
  finishedOn:   job.finishedOn || null,
  // Job payload already carries these — no extra DB lookup needed
  invoice: {
    invoice_no:    job.data?.invoiceNo || null,
    engineer_name: job.data?.engineerName || null,
    email:         job.data?.email || null,
  },
})

router.get('/queue', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100)
    const q = invoiceQueue

    const [counts, isPaused, active, waiting, delayed, failed, completed] = await Promise.all([
      q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused', 'prioritized'),
      q.isPaused(),
      q.getJobs(['active'], 0, limit - 1),
      q.getJobs(['waiting', 'prioritized'], 0, limit - 1, true),  // oldest first = next to run
      q.getJobs(['delayed'], 0, limit - 1, true),
      q.getJobs(['failed'], 0, limit - 1),
      q.getJobs(['completed'], 0, limit - 1),
    ])

    counts.waiting = (counts.waiting || 0) + (counts.prioritized || 0)

    let workers = null
    try { workers = (await q.getWorkers()).length } catch { /* CLIENT LIST not permitted */ }

    const pack = (list, state) => list.filter(Boolean).map(j => serializeJob(j, state))
    res.json({
      name: q.name,
      isPaused,
      workers,
      counts,
      jobs: {
        active:    pack(active, 'active'),
        waiting:   pack(waiting, 'waiting'),
        delayed:   pack(delayed, 'delayed'),
        failed:    pack(failed, 'failed'),
        completed: pack(completed, 'completed'),
      },
      at: Date.now(),
    })
  } catch (error) {
    console.error('Invoice queue snapshot failed:', error)
    res.status(500).json({ message: 'Could not read the email queue (is Redis reachable?)' })
  }
})

router.post('/queue/pause', async (_req, res) => {
  try { await invoiceQueue.pause(); res.json({ isPaused: true }) }
  catch (e) { res.status(500).json({ message: e.message }) }
})

router.post('/queue/resume', async (_req, res) => {
  try { await invoiceQueue.resume(); res.json({ isPaused: false }) }
  catch (e) { res.status(500).json({ message: e.message }) }
})

// Retry jobs BullMQ has given up on (all attempts used)
router.post('/queue/retry-failed', async (_req, res) => {
  try {
    const failed = (await invoiceQueue.getJobs(['failed'], 0, 999)).filter(Boolean)
    let retried = 0
    const ids = []
    for (const job of failed) {
      try {
        await job.retry()
        retried++
        if (job.data?.invoiceId) ids.push(job.data.invoiceId)
      } catch { /* job removed or locked — skip */ }
    }
    if (ids.length) await Invoice.update({ status: 'pending', send_error: null }, { where: { id: ids } })
    res.json({ retried, message: `Retried ${retried} job(s)` })
  } catch (error) {
    console.error('Queue retry-failed failed:', error)
    res.status(500).json({ message: 'Failed to retry jobs' })
  }
})


// ══════════════════════════════════════════════════════════════════
//  BULK UPLOAD
//  1. GET  /bulk/template      → blank .xlsx / .csv with the right columns
//  2. POST /bulk/validate      → parse + validate, writes nothing
//  3. POST /bulk/commit        → re-validate, save valid rows (status 'saved')
//  4. POST /:id/attach-and-send→ browser uploads each generated PDF → queued
//  5. GET  /bulk/:batchId      → live status of every invoice in the batch
//  PDFs are rendered in the browser with the same @react-pdf template
//  as single invoices, so bulk and single invoices always look identical.
// ══════════════════════════════════════════════════════════════════

// Settings arrive as a JSON string (multipart) or object (JSON body).
const readSettings = (input) => {
  let s = input
  if (typeof s === 'string') {
    try { s = JSON.parse(s) } catch { s = {} }
  }
  const allowed = Object.keys(defaultBatchSettings())
  const out = {}
  for (const k of allowed) {
    if (s && s[k] !== undefined && s[k] !== null && String(s[k]).trim() !== '') out[k] = s[k]
  }
  return { ...defaultBatchSettings(), ...out }
}

// Checks that need the database. Mutates each result's errors/warnings.
const checkAgainstDb = async (results) => {
  const invoiceNos = results.map(r => r.data.invoice_no).filter(Boolean)
  const erbNos     = [...new Set(results.map(r => r.data.erb_no).filter(Boolean))]

  const [existingNos, existingForFY] = await Promise.all([
    invoiceNos.length
      ? Invoice.findAll({ attributes: ['invoice_no'], where: { invoice_no: { [Op.in]: invoiceNos } }, raw: true })
      : [],
    erbNos.length
      ? Invoice.findAll({
          attributes: ['erb_no', 'financial_year', 'invoice_no', 'status'],
          where: { erb_no: { [Op.in]: erbNos } },
          raw: true,
        })
      : [],
  ])

  const takenNos = new Set(existingNos.map(r => String(r.invoice_no).toUpperCase()))
  const priorByKey = new Map()
  for (const r of existingForFY) {
    const key = `${r.erb_no}|${r.financial_year}`.toUpperCase()
    if (!priorByKey.has(key)) priorByKey.set(key, [])
    priorByKey.get(key).push(r)
  }

  for (const r of results) {
    if (takenNos.has(r.data.invoice_no.toUpperCase())) {
      r.errors.push(`Invoice number ${r.data.invoice_no} already exists in Invoice Records`)
    }
    const prior = priorByKey.get(`${r.data.erb_no}|${r.data.financial_year}`.toUpperCase())
    if (prior?.length) {
      const list = prior.map(p => `${p.invoice_no} (${p.status})`).join(', ')
      r.warnings.push(`Engineer already has an invoice for FY ${r.data.financial_year}: ${list}`)
    }
  }
  return results
}

const summarise = (results) => ({
  total:        results.length,
  valid:        results.filter(r => !r.errors.length).length,
  withWarnings: results.filter(r => !r.errors.length && r.warnings.length).length,
  invalid:      results.filter(r => r.errors.length).length,
  totalAmount:  results.filter(r => !r.errors.length).reduce((a, r) => a + r.data.total_amount, 0),
})

// ── GET /bulk/template?format=xlsx|csv ───────────────────────────
router.get('/bulk/template', (req, res) => {
  const { buffer, mime, ext } = buildTemplate(req.query.format === 'csv' ? 'csv' : 'xlsx')
  res.setHeader('Content-Type', mime)
  res.setHeader('Content-Disposition', `attachment; filename="erb-bulk-invoice-template.${ext}"`)
  res.send(buffer)
})

// ── POST /bulk/validate (multipart: file, settings) ──────────────
router.post('/bulk/validate', (req, res, next) => {
  bulkUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB' : err.message
      return res.status(400).json({ message: msg })
    }
    next()
  })
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Please attach a .csv or .xlsx file' })

    let parsed
    try {
      parsed = parseSpreadsheet(req.file.buffer, req.file.originalname)
    } catch (e) {
      return res.status(400).json({ message: `Could not read the file: ${e.message}` })
    }

    if (parsed.missingRequired.length) {
      return res.status(400).json({
        message: `Missing required column(s): ${parsed.missingRequired.join(', ')}. Download the template to see the expected headers.`,
        missingRequired: parsed.missingRequired,
      })
    }
    if (!parsed.rows.length) return res.status(400).json({ message: 'The file has headers but no data rows' })
    if (parsed.rows.length > MAX_BULK_ROWS) {
      return res.status(400).json({ message: `Too many rows (${parsed.rows.length}). Maximum is ${MAX_BULK_ROWS} per upload — split the file.` })
    }

    const settings = readSettings(req.body.settings)
    const batch_id = newBatchId()
    const results  = await checkAgainstDb(validateBatch(parsed.rows, settings, batch_id))

    res.json({
      batch_id,
      settings,
      file_name:      req.file.originalname,
      unknownHeaders: parsed.unknownHeaders,
      summary:        summarise(results),
      rows:           results,
    })
  } catch (error) {
    console.error('Bulk validate failed:', error)
    res.status(500).json({ message: 'Failed to validate the file' })
  }
})

// ── POST /bulk/commit (JSON: batch_id, settings, rows:[{row,data}]) ──
// Everything is re-validated here — the browser's copy is never trusted.
router.post('/bulk/commit', async (req, res) => {
  try {
    const { batch_id, rows } = req.body || {}
    if (!batch_id || !/^B[A-Z0-9]{6,20}$/.test(batch_id)) {
      return res.status(400).json({ message: 'Invalid batch id — validate the file again' })
    }
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ message: 'No rows selected' })
    if (rows.length > MAX_BULK_ROWS) return res.status(400).json({ message: `Maximum is ${MAX_BULK_ROWS} rows` })

    const already = await Invoice.count({ where: { batch_id } })
    if (already) return res.status(409).json({ message: 'This batch has already been saved. Open it from the send step or Invoice Records.' })

    const settings = readSettings(req.body.settings)
    const results  = await checkAgainstDb(
      validateBatch(rows.map(r => ({ row: r.row, raw: r.data || {} })), settings, batch_id)
    )

    const good     = results.filter(r => !r.errors.length)
    const rejected = results.filter(r => r.errors.length).map(r => ({ row: r.row, errors: r.errors }))

    if (!good.length) return res.status(400).json({ message: 'None of the selected rows are valid', rejected })

    const created = await sequelize.transaction(async (transaction) =>
      Invoice.bulkCreate(
        good.map(r => ({ ...r.data, batch_id, status: 'saved' })),
        { transaction, validate: true }
      )
    )

    // bulkCreate on MySQL doesn't return ids reliably → read them back
    const saved = await Invoice.findAll({ where: { batch_id }, order: [['id', 'ASC']] })

    res.status(201).json({
      message: `${saved.length} invoice(s) saved`,
      batch_id,
      created: saved,
      createdCount: created.length,
      rejected,
    })
  } catch (error) {
    console.error('Bulk commit failed:', error)
    res.status(500).json({ message: 'Failed to save the invoices' })
  }
})

// ── GET /bulk/:batchId — status of a batch ───────────────────────
router.get('/bulk/:batchId', async (req, res) => {
  try {
    const invoices = await Invoice.findAll({
      where: { batch_id: req.params.batchId },
      order: [['id', 'ASC']],
    })
    if (!invoices.length) return res.status(404).json({ message: 'Batch not found' })

    const counts = invoices.reduce((acc, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc }, {})
    res.json({ batch_id: req.params.batchId, counts, total: invoices.length, data: invoices })
  } catch (error) {
    console.error('Bulk status failed:', error)
    res.status(500).json({ message: 'Failed to fetch batch status' })
  }
})

// ── POST /:id/attach-and-send — attach generated PDF to a saved record & queue it ──
// Uses the stored (validated) record, not client-supplied fields.
router.post('/:id/attach-and-send', upload.single('file'), async (req, res) => {
  const cleanup = () => { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path) }
  try {
    const invoice = await Invoice.findByPk(req.params.id)
    if (!invoice) { cleanup(); return res.status(404).json({ message: 'Invoice not found' }) }
    if (!req.file) return res.status(400).json({ message: 'Invoice PDF is required' })
    if (!invoice.email) { cleanup(); return res.status(400).json({ message: 'This invoice has no email address' }) }
    if (['sent', 'pending'].includes(invoice.status) && req.query.force !== '1') {
      cleanup()
      return res.status(409).json({ message: `Invoice is already ${invoice.status === 'sent' ? 'sent' : 'queued'}`, invoice })
    }

    // Remove a previous PDF for this record, if any
    if (invoice.file_path && invoice.file_path !== req.file.path && fs.existsSync(invoice.file_path)) {
      try { fs.unlinkSync(invoice.file_path) } catch { /* ignore */ }
    }

    await invoice.update({
      file_name:     req.file.filename,
      original_name: req.file.originalname,
      file_path:     req.file.path,
      status:        'pending',
      send_error:    null,
    })

    await queueInvoiceEmail(invoice)
    res.json({ message: 'Invoice queued for sending', invoice })
  } catch (error) {
    cleanup()
    console.error('Invoice attach-and-send failed:', error)
    res.status(500).json({ message: 'Failed to queue invoice' })
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

    await invoice.update({ status: 'pending', send_error: null })
    await queueInvoiceEmail(invoice)

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
      JOB_OPTS
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
