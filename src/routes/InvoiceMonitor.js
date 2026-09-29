
const express = require('express')
const { Op, QueryTypes } = require('sequelize')
const { sequelize, ErbInvoice } = require('../models')
const { invoiceEmailQueue } = require('../queues/invoiceQueue')

const router = express.Router()

const JOB_NAME = 'send-invoice'
const JOB_OPTS = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 15000 },
    removeOnComplete: 1000,
    removeOnFail: 2000,
}


const requireAdmin = (req, res, next) => next()

const toInt = (v) => Number(v) || 0


router.get('/stats', async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365)

        const [totalsRow] = await sequelize.query(
            `SELECT
                COUNT(*)                                                     AS total,
                SUM(status = 'sent')                                         AS sent,
                SUM(status = 'failed')                                       AS failed,
                SUM(status = 'pending')                                      AS pending,
                SUM(status = 'saved')                                        AS saved,
                SUM(status = 'sent' AND DATE(sent_at) = CURDATE())           AS sent_today,
                SUM(status = 'sent' AND sent_at >= CURDATE() - INTERVAL 6 DAY)  AS sent_week,
                SUM(status = 'sent' AND sent_at >= CURDATE() - INTERVAL 29 DAY) AS sent_month,
                SUM(status = 'pending' AND COALESCE(updated_at, created_at) < NOW() - INTERVAL 30 MINUTE) AS stuck_pending
             FROM erb_invoices`,
            { type: QueryTypes.SELECT }
        )

        // Sent per day (by sent_at) and failed per day (by last update)
        const sentDaily = await sequelize.query(
            `SELECT DATE_FORMAT(sent_at, '%Y-%m-%d') AS day, COUNT(*) AS n
               FROM erb_invoices
              WHERE status = 'sent' AND sent_at >= CURDATE() - INTERVAL :d DAY
              GROUP BY day`,
            { type: QueryTypes.SELECT, replacements: { d: days - 1 } }
        )
        const failedDaily = await sequelize.query(
            `SELECT DATE_FORMAT(COALESCE(updated_at, created_at), '%Y-%m-%d') AS day, COUNT(*) AS n
               FROM erb_invoices
              WHERE status = 'failed' AND COALESCE(updated_at, created_at) >= CURDATE() - INTERVAL :d DAY
              GROUP BY day`,
            { type: QueryTypes.SELECT, replacements: { d: days - 1 } }
        )

        const map = {}
        sentDaily.forEach(r => { map[r.day] = { date: r.day, sent: toInt(r.n), failed: 0 } })
        failedDaily.forEach(r => {
            map[r.day] = map[r.day] || { date: r.day, sent: 0, failed: 0 }
            map[r.day].failed = toInt(r.n)
        })

        res.json({
            days,
            totals: {
                total: toInt(totalsRow.total),
                sent: toInt(totalsRow.sent),
                failed: toInt(totalsRow.failed),
                pending: toInt(totalsRow.pending),
                saved: toInt(totalsRow.saved),
            },
            sent_today: toInt(totalsRow.sent_today),
            sent_week: toInt(totalsRow.sent_week),
            sent_month: toInt(totalsRow.sent_month),
            stuck_pending: toInt(totalsRow.stuck_pending),
            daily: Object.values(map).sort((a, b) => a.date.localeCompare(b.date)),
        })
    } catch (err) {
        console.error('[invoice/stats]', err)
        res.status(500).json({ message: 'Could not load invoice stats' })
    }
})

// ─────────────────────────────────────────────────────────────────
// POST /resend-failed   body: { includeStuck?: boolean, batch_id?: string }
// Re-queues every failed invoice that has an email address
// ─────────────────────────────────────────────────────────────────
router.post('/resend-failed', requireAdmin, async (req, res) => {
    try {
        const { includeStuck = false, batch_id } = req.body || {}

        const statusWhere = includeStuck
            ? {
                [Op.or]: [
                    { status: 'failed' },
                    {
                        status: 'pending',
                        updated_at: { [Op.lt]: new Date(Date.now() - 30 * 60 * 1000) },
                    },
                ],
            }
            : { status: 'failed' }

        const where = {
            ...statusWhere,
            email: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] },
            ...(batch_id ? { batch_id } : {}),
        }

        const invoices = await ErbInvoice.findAll({ where, attributes: ['id'] })
        if (!invoices.length) return res.json({ queued: 0, message: 'No failed invoices to resend' })

        const ids = invoices.map(i => i.id)

        // Flip to pending first so a double-click can't queue them twice
        await ErbInvoice.update(
            { status: 'pending', send_error: null },
            { where: { id: ids } }
        )

        await invoiceEmailQueue.addBulk(ids.map(id => ({
            name: JOB_NAME,
            data: { invoiceId: id },              // ← must match your worker
            opts: { ...JOB_OPTS, jobId: `invoice-${id}-${Date.now()}` },
        })))

        res.json({ queued: ids.length, message: `Queued ${ids.length} invoice(s) for resending` })
    } catch (err) {
        console.error('[invoice/resend-failed]', err)
        res.status(500).json({ message: 'Could not queue failed invoices' })
    }
})

// ─────────────────────────────────────────────────────────────────
// GET /queue   — live BullMQ snapshot for the in-app monitor
// ─────────────────────────────────────────────────────────────────
const serializeJob = (job, state) => ({
    id: job.id,
    name: job.name,
    state,
    invoiceId: job.data?.invoiceId ?? null,
    attemptsMade: job.attemptsMade,
    attempts: job.opts?.attempts || 1,
    progress: job.progress,
    failedReason: job.failedReason || null,
    createdAt: job.timestamp || null,
    processedOn: job.processedOn || null,
    finishedOn: job.finishedOn || null,
    delay: job.opts?.delay || 0,
})

router.get('/queue', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100)
        const q = invoiceEmailQueue

        const [counts, isPaused, active, waiting, delayed, failed, completed] = await Promise.all([
            q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
            q.isPaused(),
            q.getJobs(['active'], 0, limit - 1),
            q.getJobs(['waiting'], 0, limit - 1, true),   // oldest first = next to run
            q.getJobs(['delayed'], 0, limit - 1, true),
            q.getJobs(['failed'], 0, limit - 1),
            q.getJobs(['completed'], 0, limit - 1),
        ])

        // Worker count tells you whether anything is actually consuming the queue
        let workers = null
        try { workers = (await q.getWorkers()).length } catch { /* Redis CLIENT LIST not permitted */ }

        const jobs = {
            active: active.filter(Boolean).map(j => serializeJob(j, 'active')),
            waiting: waiting.filter(Boolean).map(j => serializeJob(j, 'waiting')),
            delayed: delayed.filter(Boolean).map(j => serializeJob(j, 'delayed')),
            failed: failed.filter(Boolean).map(j => serializeJob(j, 'failed')),
            completed: completed.filter(Boolean).map(j => serializeJob(j, 'completed')),
        }

        // Attach engineer / invoice info so the monitor is readable
        const ids = [...new Set(Object.values(jobs).flat().map(j => j.invoiceId).filter(Boolean))]
        if (ids.length) {
            const invs = await ErbInvoice.findAll({
                where: { id: ids },
                attributes: ['id', 'invoice_no', 'engineer_name', 'email', 'erb_no'],
                raw: true,
            })
            const byId = Object.fromEntries(invs.map(i => [String(i.id), i]))
            Object.values(jobs).flat().forEach(j => { j.invoice = byId[String(j.invoiceId)] || null })
        }

        res.json({ name: q.name, isPaused, workers, counts, jobs, at: Date.now() })
    } catch (err) {
        console.error('[invoice/queue]', err)
        res.status(500).json({ message: 'Could not read the email queue (is Redis reachable?)' })
    }
})

router.post('/queue/pause', requireAdmin, async (req, res) => {
    await invoiceEmailQueue.pause()
    res.json({ isPaused: true })
})

router.post('/queue/resume', requireAdmin, async (req, res) => {
    await invoiceEmailQueue.resume()
    res.json({ isPaused: false })
})

// Retry the queue's own failed jobs (those that exhausted their attempts)
router.post('/queue/retry-failed', requireAdmin, async (req, res) => {
    const failed = await invoiceEmailQueue.getJobs(['failed'], 0, 999)
    await Promise.all(failed.map(j => j.retry().catch(() => null)))
    const ids = failed.map(j => j.data?.invoiceId).filter(Boolean)
    if (ids.length) await ErbInvoice.update({ status: 'pending', send_error: null }, { where: { id: ids } })
    res.json({ retried: failed.length })
})

module.exports = router