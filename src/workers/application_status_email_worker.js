import { Worker } from 'bullmq';
import connection from '../redis/connection.js';
import { sendStyledMail } from '../utils/mailer.js';
import * as db from '../models/index.js';

const EmailLog = db.sequelize.models.EmailLog;

const PORTAL_URL = 'https://registration.erb.go.ug';

// One template per applicant-facing lifecycle event. Keeping all three
// in one worker (rather than one queue per event) mirrors how close
// they are: same recipient, same idempotent EmailLog bookkeeping, only
// the copy changes.
function buildEmail({ type, applicantName, trackingNumber, applicationType, reason, licenseNumber, applicationId, registrationFee }) {
  const name         = applicantName || 'Applicant';
  const licenceLabel = applicationType || 'licence';
  const trackingLine = trackingNumber
    ? `<p style="font-size:15px;margin:14px 0;"><strong>Tracking number: ${trackingNumber}</strong></p>`
    : '';

  if (type === 'RECEIVED') {
    return {
      subject: `ERB: Application Received${trackingNumber ? ` — ${trackingNumber}` : ''}`,
      body: `
        <h2 style="margin-top:0;">Dear ${name},</h2>
        <p>We have received your ${licenceLabel} application with the Engineers Registration Board.</p>
        ${trackingLine}
        <p>You can use this tracking number to follow your application's status on the ERB portal.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${PORTAL_URL}" style="background-color:#1e40af;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Track Application</a>
        </p>
        <p>Regards,<br/><strong>ERB Support Team</strong></p>`,
    };
  }

  if (type === 'SENT_BACK') {
    return {
      subject: `ERB: Updates Needed on Your Application${trackingNumber ? ` — ${trackingNumber}` : ''}`,
      body: `
        <h2 style="margin-top:0;">Dear ${name},</h2>
        <p>Your ${licenceLabel} application has been sent back for some updates before it can proceed.</p>
        ${trackingLine}
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px;margin:16px 0;">
          <p style="margin:0;color:#78350f;"><strong>Reason:</strong> ${reason || 'Please review your application for the requested changes.'}</p>
        </div>
        <p>Please log in to the ERB portal, make the requested edits, and resubmit your application.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${PORTAL_URL}" style="background-color:#b45309;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Update Application</a>
        </p>
        <p>Regards,<br/><strong>ERB Support Team</strong></p>`,
    };
  }

  // APPROVED
  const paymentUrl = applicationId ? `${PORTAL_URL}/application/${applicationId}` : PORTAL_URL;
  const fmtUGX = (n) => (n == null ? null : `UGX ${Number(n).toLocaleString()}`);
  const feeLine = registrationFee
    ? `<p style="margin:0 0 10px;">The annual registration fee due is <strong>${fmtUGX(registrationFee)}</strong>.</p>`
    : '';

  return {
    subject: `ERB: Application Approved${trackingNumber ? ` — ${trackingNumber}` : ''}`,
    body: `
      <h2 style="margin-top:0;">Dear ${name},</h2>
      <p>Congratulations — your ${licenceLabel} application has been approved by the Engineers Registration Board.</p>
      ${trackingLine}
      ${licenseNumber ? `<p style="font-size:15px;margin:14px 0;"><strong>Licence number: ${licenseNumber}</strong></p>` : ''}
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:18px 0;">
        <p style="margin:0 0 10px;font-weight:bold;color:#065f46;">Next step: pay your annual registration fee</p>
        ${feeLine}
        <p style="margin:0 0 6px;">You can pay either way:</p>
        <ul style="margin:0 0 10px;padding-left:20px;">
          <li>Online via Mobile Money (MTN or Airtel) — the quickest option, confirmed instantly.</li>
          <li>By bank transfer to the ERB account, then attach your payment receipt on the portal for Accounts to verify.</li>
        </ul>
        <p style="margin:0;">Log in to the portal and open this application to pay online or attach your receipt.</p>
      </div>
      <p style="text-align:center;margin:28px 0;">
        <a href="${paymentUrl}" style="background-color:#065f46;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Pay Registration Fee</a>
      </p>
      <p>Regards,<br/><strong>ERB Support Team</strong></p>`,
  };
}

const worker = new Worker(
  'applicationStatusEmailQueue',
  async job => {
    const { to, type } = job.data;
    let emailLog;

    try {
      await job.updateProgress(10);

      if (!to) throw new Error('Missing applicant email');
      if (!['RECEIVED', 'SENT_BACK', 'APPROVED'].includes(type)) {
        throw new Error(`Unknown application status email type: ${type}`);
      }

      // Idempotent for retries — same pattern as sponsor_notification_worker.js.
      emailLog = await EmailLog.findOne({ where: { job_id: job.id } });

      if (emailLog?.status === 'SENT') {
        console.log(`[ApplicationStatusEmailWorker] Job ${job.id} already SENT → skipping`);
        return { success: true, skipped: true };
      }

      if (!emailLog) {
        emailLog = await EmailLog.create({
          job_id: job.id,
          recipient_email: to,
          registration_no: job.data.trackingNumber || null,
          status: 'PENDING',
        });
      }

      await job.updateProgress(40);

      const { subject, body } = buildEmail(job.data);
      const htmlContent = `
        <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f8f2f2; padding: 30px;">
          <div style="max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 8px;">
            <div style="background-color: #1e40af; padding: 20px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 20px;">Engineers Registration Board (ERB)</h1>
            </div>
            <div style="padding: 25px;">
              ${body}
            </div>
          </div>
        </div>`;

      await job.updateProgress(70);

      await sendStyledMail(to, subject, htmlContent);

      await emailLog.update({ status: 'SENT', sent_at: new Date() });

      await job.updateProgress(100);

      return { success: true, to, type };
    } catch (err) {
      console.error(`[ApplicationStatusEmailWorker] Error for job ${job.id} → ${to}`, err);

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
  console.log(`[ApplicationStatusEmailWorker] ✅ Job ${job.id} completed → ${job.data.to} (${job.data.type})`);
});

worker.on('failed', (job, err) => {
  console.error(`[ApplicationStatusEmailWorker] ❌ Job ${job?.id} failed → ${job?.data?.to}`, err.message);
});

worker.on('error', err => {
  console.error('[ApplicationStatusEmailWorker] Worker error:', err);
});

export default worker;
