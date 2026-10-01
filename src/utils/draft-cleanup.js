// ── Inactive draft cleanup ───────────────────────────────────────────
// Licence-application DRAFTS (not yet submitted) that the applicant stops
// working on are cleaned up automatically:
//
//   day 10 idle  → warning email ("continue within 4 days or it's removed")
//   day 14 idle  → soft-deleted, if the warning went out ≥ 4 days earlier
//   day 15+ idle → soft-deleted regardless (covers the existing backlog and
//                  any time the job didn't run) — with a removal email
//
// "Idle" = no save by the applicant since `updated_at`. Every wizard step
// autosaves through POST /submit-application, which bumps updated_at and
// clears the warning/deletion fields, so any activity resets the clock and
// even restores a soft-deleted draft.
//
// Soft-delete = status 'DELETED' (+ deleted_at / deleted_reason). The row
// and everything in it is kept; it's just hidden from every list and
// lookup (see NOT_SOFT_DELETED in routes/application_routes.js).
//
// Only drafts are touched. Submitted applications (draft_type COMPLETE) and
// sent-back ones (status DEFERRED) are never auto-deleted.
//
// Writes below use `silent: true` so stamping the warning doesn't itself
// bump updated_at and reset the inactivity clock.
import { Op } from 'sequelize'
import { Application } from '../models/index.js'
import applicationStatusEmailQueue from '../queues/application_status_email_queue.js'
import { formatApplicantName } from './applicant-name.js'

const DAY = 24 * 60 * 60 * 1000
export const WARN_AFTER_DAYS          = 10
export const DELETE_AFTER_WARNING_DAYS = 4   // → deleted at day 14
export const HARD_LIMIT_DAYS          = 15  // deleted regardless

const trackingNumber = (id) => `ERB-${String(id).padStart(5, '0')}`

const DRAFTS_ONLY = {
  [Op.and]: [
    { [Op.or]: [{ draft_type: null }, { draft_type: { [Op.ne]: 'COMPLETE' } }] },
    { [Op.or]: [{ status: null }, { status: { [Op.notIn]: ['DELETED', 'DEFERRED'] } }] },
  ],
}

async function queueEmail(app, type, extra = {}) {
  if (!app.email_address) return false
  await applicationStatusEmailQueue.add(
    type === 'INACTIVITY_WARNING' ? 'draft-inactivity-warning' : 'draft-inactivity-deleted',
    {
      type,
      to:              app.email_address,
      applicantName:   formatApplicantName(app),
      trackingNumber:  trackingNumber(app.id),
      applicationType: app.type,
      applicationId:   app.id,
      ...extra,
    },
    {
      // Deterministic job id → a re-run of this sweep can never queue the
      // same email twice for the same application/event.
      jobId:            `${type}-${app.id}-${new Date(app.updated_at).getTime()}`,
      attempts:         3,
      backoff:          { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail:     false,
    }
  )
  return true
}

export async function runDraftCleanup({ now = new Date(), dryRun = false } = {}) {
  const warnBefore   = new Date(now - WARN_AFTER_DAYS * DAY)
  const deleteBefore = new Date(now - (WARN_AFTER_DAYS + DELETE_AFTER_WARNING_DAYS) * DAY)
  const hardBefore   = new Date(now - HARD_LIMIT_DAYS * DAY)
  const warnedBefore = new Date(now - DELETE_AFTER_WARNING_DAYS * DAY)

  const summary = { warned: 0, deleted: 0, emails: 0 }

  // 1) Soft-delete: 15+ days idle, or 14+ days idle and warned ≥ 4 days ago.
  const toDelete = await Application.findAll({
    where: {
      ...DRAFTS_ONLY,
      [Op.or]: [
        { updated_at: { [Op.lt]: hardBefore } },
        {
          updated_at:                 { [Op.lt]: deleteBefore },
          inactivity_warning_sent_at: { [Op.ne]: null, [Op.lt]: warnedBefore },
        },
      ],
    },
  })

  for (const app of toDelete) {
    const raw = app.toJSON()
    const idleDays = Math.floor((now - new Date(raw.updated_at)) / DAY)
    if (!dryRun) {
      await app.update(
        {
          status:         'DELETED',
          deleted_at:     now,
          deleted_reason: `Inactive draft — no activity for ${idleDays} days`,
        },
        { silent: true }
      )
      try {
        if (await queueEmail(raw, 'INACTIVITY_DELETED', { idleDays })) summary.emails++
      } catch (err) {
        console.error(`[draft-cleanup] deletion email for ${raw.id} not queued:`, err.message)
      }
    }
    summary.deleted++
  }

  // 2) Warn: 10+ days idle, not yet warned (and not just deleted above).
  const deletedIds = new Set(toDelete.map(a => a.id))
  const toWarn = await Application.findAll({
    where: {
      ...DRAFTS_ONLY,
      updated_at:                 { [Op.lt]: warnBefore },
      inactivity_warning_sent_at: null,
    },
  })

  for (const app of toWarn) {
    if (deletedIds.has(app.id)) continue
    const raw = app.toJSON()
    if (!dryRun) {
      await app.update({ inactivity_warning_sent_at: now }, { silent: true })
      try {
        const deleteOn = new Date(now.getTime() + DELETE_AFTER_WARNING_DAYS * DAY)
        if (await queueEmail(raw, 'INACTIVITY_WARNING', { deleteOn: deleteOn.toISOString() })) summary.emails++
      } catch (err) {
        console.error(`[draft-cleanup] warning email for ${raw.id} not queued:`, err.message)
      }
    }
    summary.warned++
  }

  console.log(`[draft-cleanup] ${dryRun ? '(dry run) ' : ''}deleted ${summary.deleted}, warned ${summary.warned}, emails queued ${summary.emails}`)
  return summary
}

// Runs once shortly after startup (this is what clears the current 15+ day
// backlog) and then every 6 hours.
export function scheduleDraftCleanup({ firstRunDelayMs = 30_000, everyMs = 6 * 60 * 60 * 1000 } = {}) {
  const run = () => runDraftCleanup().catch(err => console.error('[draft-cleanup] failed:', err.message))
  setTimeout(run, firstRunDelayMs)
  setInterval(run, everyMs)
}
