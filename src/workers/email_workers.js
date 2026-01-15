import { Worker } from 'bullmq';
import connection from '../redis/connection.js';
import { sendStyledMail } from '../utils/mailer.js';
import path from 'path';
import fs from 'fs/promises';
import * as db from '../models/index.js';

const EmailLog = db.sequelize.models.EmailLog;

const worker = new Worker(
  'emailQueue',
  async job => {
    const {
      to,
      files = [],
      registrationNo
    } = job.data;

    let emailLog;

    try {
      await job.updateProgress(5);

      if (!to) {
        throw new Error('Missing recipient email');
      }

      /**
       * Create or reuse DB log (idempotent for retries)
       */
      emailLog = await EmailLog.findOne({
        where: { job_id: job.id }
      });

      // Skip resend if already sent (retry-safe)
      if (emailLog?.status === 'SENT') {
        console.log(
          `[EmailWorker] Job ${job.id} already SENT → skipping`
        );
        return { success: true, skipped: true };
      }

      if (!emailLog) {
        emailLog = await EmailLog.create({
          job_id: job.id,
          recipient_email: to,
          registration_no: registrationNo,
          status: 'PENDING'
        });
      }

      // Validate & prepare attachments (HARD SAFETY CHECK)
      const attachments = [];
      const expectedFilename =
        registrationNo
          ? `${String(registrationNo).trim()}.pdf`.toLowerCase()
          : null;

      for (const file of files) {
        try {
          const filename = path.basename(file);

          // Prevent wrong-license attachment under ALL circumstances
          if (
            expectedFilename &&
            filename.toLowerCase() !== expectedFilename
          ) {
            console.error(
              `[EmailWorker] Attachment mismatch for ${to}: expected ${expectedFilename}, got ${filename}`
            );
            continue;
          }

          await fs.access(file);

          attachments.push({
            filename,
            path: file
          });
        } catch {
          console.warn(
            `[EmailWorker] File not found for ${to}: ${file}`
          );
        }
      }

      await job.updateProgress(40);

      if (attachments.length === 0) {
        throw new Error('No valid attachments found');
      }

      const htmlContent = `
        <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f8f2f2; padding: 30px;">
          <div style="max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 8px;">
            <div style="background-color: #b30000; padding: 20px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0;">Engineers Registration Board (ERB)</h1>
            </div>

            <div style="padding: 25px;">
              <h2>Dear Engineer, 📄</h2>
              <p>Your professional practising license is attached to this email.</p>
              <p>Please download and keep it safely.</p>

              <p>
                Regards,<br/>
                <strong>ERB Support Team</strong>
              </p>
            </div>
          </div>
        </div>`;

      await job.updateProgress(70);

      await sendStyledMail(
        to,
        'RE: YOUR ERB PROFESSIONAL LICENSE',
        htmlContent,
        attachments
      );

      await emailLog.update({
        status: 'SENT',
        sent_at: new Date()
      });

      await job.updateProgress(100);

      return { success: true, to };
    } catch (err) {
      console.error(
        `[EmailWorker] Error for job ${job.id} → ${to}`,
        err
      );

      if (emailLog && emailLog.status !== 'SENT') {
        await emailLog.update({
          status: 'FAILED',
          error_message: err.message
        });
      }

      throw err; // allows BullMQ retries
    }
  },
  {
    connection,
    concurrency: 5,
    limiter: {
      max: 5,
      duration: 1000
    }
  }
);

/* ---------- Event Listeners ---------- */

worker.on('completed', job => {
  console.log(
    `[EmailWorker] ✅ Job ${job.id} completed → ${job.data.to}`
  );
});

worker.on('failed', (job, err) => {
  console.error(
    `[EmailWorker] ❌ Job ${job?.id} failed → ${job?.data?.to}`,
    err.message
  );
});

worker.on('error', err => {
  console.error('[EmailWorker] Worker error:', err);
});

export default worker;


