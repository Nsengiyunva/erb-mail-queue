import { Worker } from 'bullmq';
import connection from '../redis/connection.js';
import * as db from '../models/index.js';
import sponsorNotificationQueue from '../queues/sponsor_notification_queue.js';

const Application = db.sequelize.models.Application;

const parseJsonColumn = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return []; }
};

const worker = new Worker(
  'applicationQueue',
  async (job) => {
    const payload = job.data;

    const {
      applicationID,
      applicant_id,
      email_address,
    } = payload;

    let application;

    try {
      await job.updateProgress(5);

      if (!applicant_id) {
        throw new Error('Missing applicant_id');
      }

      // ── Validate applicationID before using it ──────────────────
      const parsedID = applicationID ? Number(applicationID) : null;
      if (applicationID && (isNaN(parsedID) || parsedID <= 0)) {
        throw new Error(`Invalid applicationID: ${applicationID}`);
      }

      // ── Idempotency key ─────────────────────────────────────────
      // The PK column in erb_applications is `id`, not `applicationID`.
      // applicationID in the payload is the frontend's reference to the
      // existing draft row — map it to `id` when building the where clause.
      const whereClause = parsedID
        ? { id: parsedID }          // ← was { applicationID } — column does not exist
        : { applicant_id };

      // ── Check existing record ───────────────────────────────────
      application = await Application.findOne({ where: whereClause });

      // ── Skip if already processed past the autosave stage (retry-safe) ──
      // Every autosave (Start/Section A/B/C/D) writes status "PENDING" via
      // the synchronous /submit-application route handler. This queued job
      // only ever runs for a genuine final submission (draft_type ===
      // "COMPLETE"), so any status other than "PENDING" here means a prior
      // run of this exact job already carried the application past the
      // autosave stage — re-running would re-send sponsor notification
      // emails on a BullMQ retry.
      if (application && application.status && application.status !== 'PENDING') {
        console.log(`[ApplicationWorker] Job ${job.id} already processed (status=${application.status}) → skipping`);
        return { success: true, skipped: true };
      }

      // Strip applicationID from the DB payload — it is not a column,
      // passing it to create/update would cause another ER_BAD_FIELD_ERROR.
      const { applicationID: _dropped, ...dbPayload } = payload;

      // ── Policy: an attached recommendation letter IS the sponsor's ──
      // approval — there is no separate confirmation step for the sponsor
      // to perform. The wizard already refuses to let an applicant submit
      // unless every nominated sponsor has a letter on file (Application.jsx,
      // step 4 gate), so by the time a submission reaches this worker,
      // sponsor sign-off is already complete in substance. Reflect that
      // immediately — both per-sponsor and on the application's overall
      // pipeline status — instead of leaving it on AWAITING_SPONSOR_APPROVAL
      // until someone visits the Sponsor Requests dashboard and clicks
      // Approve (that manual path still exists and still works, it's just
      // no longer the only way this status advances).
      const sponsors = parseJsonColumn(dbPayload.sponsors);
      const sponsorsSigned = sponsors.map(sp =>
        sp?.recommendation_letter_path
          ? { ...sp, status: 'APPROVED', approved_at: sp.approved_at || new Date().toISOString() }
          : sp
      );
      const allSponsorsSigned = sponsorsSigned.length > 0 && sponsorsSigned.every(sp => sp?.recommendation_letter_path);
      if (allSponsorsSigned) {
        dbPayload.sponsors = JSON.stringify(sponsorsSigned);
        if (dbPayload.status === 'AWAITING_SPONSOR_APPROVAL') {
          dbPayload.status = 'SPONSOR_APPROVED';
        }
      }

      // NOTE: no other `status:` override here. dbPayload already carries the
      // real pipeline status the frontend set for this submission (e.g.
      // "AWAITING_SPONSOR_APPROVAL", now possibly upgraded to
      // "SPONSOR_APPROVED" just above) — this worker used to stomp on it
      // with a generic "PROCESSING" → "COMPLETED" job-tracking status,
      // which would make every application look fully registered the
      // instant it was submitted, well before sponsors or the board had
      // reviewed it.

      // ── CREATE ──────────────────────────────────────────────────
      if (!application) {
        application = await Application.create({ ...dbPayload });
        console.log(`[ApplicationWorker] Created application → ${application.id}`);
      } else {
        // ── UPDATE (upsert behaviour) ──────────────────────────────
        await application.update({ ...dbPayload });
        console.log(`[ApplicationWorker] Updated application → ${application.id}`);
      }

      await job.updateProgress(50);

      // ── Notify nominated sponsors ─────────────────────────────────
      // Only for a real final submission, and only the first time this
      // application reaches that state (guarded by the status check above
      // plus a deterministic jobId below, so BullMQ retries never
      // duplicate the emails).
      const applicantName =
        dbPayload.name ||
        [dbPayload.first_name, dbPayload.other_names, dbPayload.surname].filter(Boolean).join(' ');

      for (const sponsor of sponsorsSigned) {
        if (!sponsor?.email_address) continue;
        await sponsorNotificationQueue.add(
          'notify-sponsor',
          {
            to:              sponsor.email_address,
            sponsorName:     sponsor.sponsor_name,
            applicantName,
            applicationType: dbPayload.type,
          },
          {
            jobId: `sponsor-notify-${application.id}-${sponsor.id || sponsor.registration_number || sponsor.email_address}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: false,
          }
        );
      }

      await job.updateProgress(100);

      return {
        success:        true,
        application_id: application.id,
        email:          email_address,
        sponsors_notified: sponsorsSigned.filter(s => s?.email_address).length,
      };

    } catch (err) {
      console.error(`[ApplicationWorker] Error for job ${job.id}`, err);

      // Mark as FAILED — swallow secondary errors so the original is re-thrown
      if (application) {
        await application.update({ status: 'FAILED' }).catch(() => {});
      }

      throw err; // lets BullMQ handle retries
    }
  },
  {
    connection,
    concurrency: 5,
    limiter: { max: 5, duration: 1000 },
  }
);

/* ---------- Event Listeners ---------- */

worker.on('completed', (job) => {
  console.log(`[ApplicationWorker] ✅ Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[ApplicationWorker] ❌ Job ${job?.id} failed`, err.message);
});

worker.on('error', (err) => {
  console.error('[ApplicationWorker] Worker error:', err);
});

export default worker;
