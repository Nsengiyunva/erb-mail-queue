// import { Worker } from 'bullmq';
// import connection from '../redis/connection.js';
// import * as db from '../models/index.js';

// const Application = db.sequelize.models.Application;

// const worker = new Worker(
//   'applicationQueue',
//   async (job) => {
//     const payload = job.data;

//     const {
//       applicationID,
//       applicant_id,
//       email_address
//     } = payload;

//     let application;

//     try {
//       await job.updateProgress(5);

//       if (!applicant_id) {
//         throw new Error('Missing applicant_id');
//       }

//       /**
//        * 🔐 Idempotency key
//        * Prefer applicationID, fallback to applicant_id
//        */
//       const whereClause = applicationID
//         ? { applicationID }
//         : { applicant_id };

//       /**
//        * 🔍 Check existing record
//        */
//       application = await Application.findOne({
//         where: whereClause
//       });

//       /**
//        * 🛑 Retry-safe: skip if already completed
//        */
//       if (application?.status === 'COMPLETED') {
//         console.log(
//           `[ApplicationWorker] Job ${job.id} already COMPLETED → skipping`
//         );
//         return { success: true, skipped: true };
//       }

//       /**
//        * 🆕 CREATE
//        */
//       if (!application) {
//         application = await Application.create({
//           ...payload,
//           applicationID,
//           status: 'PROCESSING'
//         });

//         console.log(
//           `[ApplicationWorker] Created application → ${application.id}`
//         );
//       } else {
//         /**
//          * 🔄 UPDATE (UPSERT behavior)
//          */
//         await application.update({
//           ...payload,
//           status: 'PROCESSING'
//         });

//         console.log(
//           `[ApplicationWorker] Updated application → ${application.id}`
//         );
//       }

//       await job.updateProgress(40);

//       /**
//        * ⚙️ Simulate processing (validation, external APIs, etc.)
//        */
//       // Example:
//       // await validateApplication(payload)
//       // await triggerPayment(payload)

//       await job.updateProgress(70);

//       /**
//        * ✅ Finalize
//        */
//       await application.update({
//         status: 'COMPLETED',
//         processed_at: new Date()
//       });

//       await job.updateProgress(100);

//       return {
//         success: true,
//         application_id: application.id,
//         email: email_address
//       };

//     } catch (err) {
//       console.error(
//         `[ApplicationWorker] Error for job ${job.id}`,
//         err
//       );

//       /**
//        * ❌ Mark as FAILED (retry-safe)
//        */
//       if (application && application.status !== 'COMPLETED') {
//         await application.update({
//           status: 'FAILED',
//           error_message: err.message
//         });
//       }

//       throw err; // 🔁 enables BullMQ retries
//     }
//   },
//   {
//     connection,
//     concurrency: 5,
//     limiter: {
//       max: 5,
//       duration: 1000
//     }
//   }
// );

// /* ---------- Event Listeners ---------- */

// worker.on('completed', (job) => {
//   console.log(
//     `[ApplicationWorker] ✅ Job ${job.id} completed`
//   );
// });

// worker.on('failed', (job, err) => {
//   console.error(
//     `[ApplicationWorker] ❌ Job ${job?.id} failed`,
//     err.message
//   );
// });

// worker.on('error', (err) => {
//   console.error('[ApplicationWorker] Worker error:', err);
// });

// export default worker;


import { Worker } from 'bullmq';
import connection from '../redis/connection.js';
import * as db from '../models/index.js';

const Application = db.sequelize.models.Application;

const worker = new Worker(
  'applicationQueue',
  async (job) => {
    const payload = job.data;

    const {
      applicationID,
      applicant_id,
      email_address
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

      // ── Skip if already completed (retry-safe) ──────────────────
      if (application?.status === 'COMPLETED') {
        console.log(`[ApplicationWorker] Job ${job.id} already COMPLETED → skipping`);
        return { success: true, skipped: true };
      }

      // Strip applicationID from the DB payload — it is not a column,
      // passing it to create/update would cause another ER_BAD_FIELD_ERROR.
      const { applicationID: _dropped, ...dbPayload } = payload;

      // ── CREATE ──────────────────────────────────────────────────
      if (!application) {
        application = await Application.create({
          ...dbPayload,
          status: 'PROCESSING',
        });

        console.log(`[ApplicationWorker] Created application → ${application.id}`);

      } else {
        // ── UPDATE (upsert behaviour) ──────────────────────────────
        await application.update({
          ...dbPayload,
          status: 'PROCESSING',
        });

        console.log(`[ApplicationWorker] Updated application → ${application.id}`);
      }

      await job.updateProgress(40);

      // ── Additional processing steps go here ─────────────────────
      // e.g. await validateApplication(dbPayload)
      //      await triggerExternalService(dbPayload)

      await job.updateProgress(70);

      // ── Finalise ─────────────────────────────────────────────────
      await application.update({ status: 'COMPLETED' });

      await job.updateProgress(100);

      return {
        success:        true,
        application_id: application.id,
        email:          email_address,
      };

    } catch (err) {
      console.error(`[ApplicationWorker] Error for job ${job.id}`, err);

      // Mark as FAILED — swallow secondary errors so the original is re-thrown
      if (application && application.status !== 'COMPLETED') {
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