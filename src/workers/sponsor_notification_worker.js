import { Worker } from 'bullmq';
import connection from '../redis/connection.js';
import { sendStyledMail } from '../utils/mailer.js';
import * as db from '../models/index.js';

const EmailLog = db.sequelize.models.EmailLog;

const PORTAL_URL = 'https://data.erb.go.ug/sponsor-requests';

const worker = new Worker(
  'sponsorNotificationQueue',
  async job => {
    const {
      to,
      sponsorName,
      applicantName,
      applicationType,
    } = job.data;

    let emailLog;

    try {
      await job.updateProgress(10);

      if (!to) {
        throw new Error('Missing sponsor email');
      }

      // Idempotent for retries — same pattern as the license-issuance worker.
      emailLog = await EmailLog.findOne({ where: { job_id: job.id } });

      if (emailLog?.status === 'SENT') {
        console.log(`[SponsorNotificationWorker] Job ${job.id} already SENT → skipping`);
        return { success: true, skipped: true };
      }

      if (!emailLog) {
        emailLog = await EmailLog.create({
          job_id: job.id,
          recipient_email: to,
          status: 'PENDING',
        });
      }

      await job.updateProgress(40);

      const displayName = sponsorName || 'Engineer';
      const applicant    = applicantName || 'An applicant';
      const licenceType  = applicationType || 'licence';

      const htmlContent = `
        <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f8f2f2; padding: 30px;">
          <div style="max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 8px;">
            <div style="background-color: #1e40af; padding: 20px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 20px;">Engineers Registration Board (ERB)</h1>
            </div>

            <div style="padding: 25px;">
              <h2 style="margin-top: 0;">Dear ${displayName},</h2>
              <p>
                <strong>${applicant}</strong> has named you as a sponsor on their
                ${licenceType} application and is requesting your recommendation
                for registration with the Engineers Registration Board.
              </p>
              <p>
                They have already attached a signed and stamped recommendation
                letter to their application for your review. Please log in to the
                ERB portal to view the request and confirm your recommendation.
              </p>

              <p style="text-align: center; margin: 28px 0;">
                <a href="${PORTAL_URL}"
                   style="background-color: #1e40af; color: #ffffff; padding: 12px 24px;
                          border-radius: 6px; text-decoration: none; font-weight: bold;
                          display: inline-block;">
                  Review Sponsor Request
                </a>
              </p>

              <p>If you did not expect this request, please contact ERB support.</p>

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
        'ERB: A Sponsor Recommendation Has Been Requested',
        htmlContent,
      );

      await emailLog.update({ status: 'SENT', sent_at: new Date() });

      await job.updateProgress(100);

      return { success: true, to };
    } catch (err) {
      console.error(`[SponsorNotificationWorker] Error for job ${job.id} → ${to}`, err);

      if (emailLog && emailLog.status !== 'SENT') {
        await emailLog.update({ status: 'FAILED', error_message: err.message });
      }

      throw err; // allows BullMQ retries
    }
  },
  {
    connection,
    concurrency: 5,
    limiter: { max: 5, duration: 1000 },
  }
);

/* ---------- Event Listeners ---------- */

worker.on('completed', job => {
  console.log(`[SponsorNotificationWorker] ✅ Job ${job.id} completed → ${job.data.to}`);
});

worker.on('failed', (job, err) => {
  console.error(`[SponsorNotificationWorker] ❌ Job ${job?.id} failed → ${job?.data?.to}`, err.message);
});

worker.on('error', err => {
  console.error('[SponsorNotificationWorker] Worker error:', err);
});

export default worker;
