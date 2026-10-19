import { Worker } from 'bullmq';
import connection from '../redis/connection.js';
import { sendStyledMail } from '../utils/mailer.js';
import { commentToHtml, DEFAULT_STYLES } from '../utils/rich-text.js';
import * as db from '../models/index.js';
import fs from 'fs';
import path from 'path';

const EmailLog = db.sequelize.models.EmailLog;
const Application = db.Application;

// Same directory application_routes.js stores uploads (and approval letters) in.
const UPLOADS_DIR = path.resolve('/home/user1/uploads');

const PORTAL_URL = 'https://registration.erb.go.ug';

// erb_email_logs is shared by several workers (emailQueue, sponsor
// notifications, this one), and BullMQ job ids are only unique *within* a
// queue — every queue counts 1, 2, 3… independently. Looking the log up by
// the bare job.id meant that once emailQueue had sent its own job "57",
// this worker's job "57" (e.g. a "sent back for corrections" email) found
// that SENT row, logged "already SENT → skipping", and silently never
// emailed the applicant. Namespacing the id makes the idempotency check
// only ever match this queue's own jobs.
const LOG_ID_PREFIX = 'appStatus:';

const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  .replace(/\n/g, '<br/>');

// Officer comments may be rich text (bold, lists…) or plain text — render
// both as sanitised HTML with inline styles email clients respect.
const commentHtml = (text, color) => commentToHtml(text, {
  ...DEFAULT_STYLES,
  p:  `${DEFAULT_STYLES.p}color:${color};`,
  ul: `${DEFAULT_STYLES.ul}color:${color};`,
  ol: `${DEFAULT_STYLES.ol}color:${color};`,
});

// One template per applicant-facing lifecycle event. Keeping all three
// in one worker (rather than one queue per event) mirrors how close
// they are: same recipient, same idempotent EmailLog bookkeeping, only
// the copy changes.
function buildEmail({ type, applicantName, trackingNumber, applicationType, reason, licenseNumber, applicationId, registrationFee, authorName, deleteOn, idleDays, approvalLetter }) {
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
          <p style="margin:0 0 6px;color:#78350f;"><strong>Reason:</strong></p>
          <div style="color:#78350f;line-height:1.5;">${commentHtml(reason, '#78350f') || '<p style="margin:0;">Please review your application for the requested changes.</p>'}</div>
        </div>
        <p>Please log in to the ERB portal, make the requested edits, and resubmit your application.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${PORTAL_URL}" style="background-color:#b45309;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Update Application</a>
        </p>
        <p>Regards,<br/><strong>ERB Support Team</strong></p>`,
    };
  }

  if (type === 'INACTIVITY_WARNING') {
    const when = deleteOn
      ? new Date(deleteOn).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'in 4 days';
    return {
      subject: `ERB: Your Draft Application Will Be Removed Soon${trackingNumber ? ` — ${trackingNumber}` : ''}`,
      body: `
        <h2 style="margin-top:0;">Dear ${name},</h2>
        <p>Your ${licenceLabel} application with the Engineers Registration Board is still a draft and hasn't been updated for 10 days.</p>
        ${trackingLine}
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px;margin:16px 0;">
          <p style="margin:0;color:#78350f;">If there's no further activity, this draft will be removed on <strong>${when}</strong>.</p>
        </div>
        <p>To keep it, simply log in and continue your application — any progress you save keeps it active.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${PORTAL_URL}" style="background-color:#b45309;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Continue Application</a>
        </p>
        <p>Regards,<br/><strong>ERB Support Team</strong></p>`,
    };
  }

  if (type === 'INACTIVITY_DELETED') {
    return {
      subject: `ERB: Draft Application Removed Due to Inactivity${trackingNumber ? ` — ${trackingNumber}` : ''}`,
      body: `
        <h2 style="margin-top:0;">Dear ${name},</h2>
        <p>Your draft ${licenceLabel} application has been removed because it wasn't updated for ${idleDays ? `${idleDays} days` : 'more than two weeks'}.</p>
        ${trackingLine}
        <p>If you're still interested in registering with the Engineers Registration Board, you're welcome to log in and start your application again at any time.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${PORTAL_URL}" style="background-color:#1e40af;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Start a New Application</a>
        </p>
        <p>Regards,<br/><strong>ERB Support Team</strong></p>`,
    };
  }

  if (type === 'REGISTERED') {
    return {
      subject: `ERB: Registration Complete${licenseNumber ? ` — Licence No. ${licenseNumber}` : ''}`,
      body: `
        <h2 style="margin-top:0;">Dear ${name},</h2>
        <p>Your registration with the Engineers Registration Board is now complete.</p>
        ${trackingLine}
        ${licenseNumber ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:18px 0;text-align:center;">
          <p style="margin:0;color:#065f46;font-size:13px;">Your licence number</p>
          <p style="margin:6px 0 0;color:#065f46;font-size:22px;font-weight:bold;letter-spacing:1px;">${escapeHtml(licenseNumber)}</p>
        </div>` : ''}
        <p>Please quote this number in all correspondence with the Board. You can view your registration and licence details on the ERB portal.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${PORTAL_URL}" style="background-color:#065f46;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Open ERB Portal</a>
        </p>
        <p>Regards,<br/><strong>ERB Support Team</strong></p>`,
    };
  }

  if (type === 'COMMENT') {
    return {
      subject: `ERB: New Comment on Your Application${trackingNumber ? ` — ${trackingNumber}` : ''}`,
      body: `
        <h2 style="margin-top:0;">Dear ${name},</h2>
        <p>An ERB officer has added a comment to your ${licenceLabel} application.</p>
        ${trackingLine}
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px;margin:16px 0;">
          <div style="margin:0 0 6px;color:#1e3a8a;line-height:1.5;">${commentHtml(reason, '#1e3a8a')}</div>
          <p style="margin:0;color:#3b82f6;font-size:12px;">— ${escapeHtml(authorName || 'ERB Officer')}</p>
        </div>
        <p>Log in to the ERB portal and open your application to read the full thread or reply.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${PORTAL_URL}" style="background-color:#1e40af;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">View Application</a>
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
      ${approvalLetter ? `<p style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin:16px 0;color:#1e3a8a;">📎 Your official <strong>approval letter</strong> from the Board is attached to this email. Please keep it for your records — it sets out the dues payable and the deadline for payment.</p>` : ''}
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
      if (!['RECEIVED', 'SENT_BACK', 'APPROVED', 'REGISTERED', 'COMMENT', 'INACTIVITY_WARNING', 'INACTIVITY_DELETED'].includes(type)) {
        throw new Error(`Unknown application status email type: ${type}`);
      }

      // Idempotent for retries — same pattern as sponsor_notification_worker.js.
      const logId = `${LOG_ID_PREFIX}${job.id}`;
      emailLog = await EmailLog.findOne({ where: { job_id: logId } });

      if (emailLog?.status === 'SENT') {
        console.log(`[ApplicationStatusEmailWorker] Job ${job.id} already SENT → skipping`);
        return { success: true, skipped: true };
      }

      if (!emailLog) {
        emailLog = await EmailLog.create({
          job_id: logId,
          recipient_email: to,
          registration_no: job.data.trackingNumber || null,
          status: 'PENDING',
        });
      }

      await job.updateProgress(40);

      // ── Approval letter: attach it, and never send it twice ─────────
      let attachments = [];
      let letterApp = null;
      if (type === 'APPROVED' && job.data.approvalLetter?.filename && job.data.applicationId) {
        letterApp = await Application.findOne({ where: { id: job.data.applicationId } });
        if (letterApp?.approval_letter_sent_at) {
          console.log(`[ApplicationStatusEmailWorker] Approval letter for application ${job.data.applicationId} already sent at ${letterApp.approval_letter_sent_at.toISOString?.() || letterApp.approval_letter_sent_at} → skipping`);
          await emailLog.update({ status: 'SENT', sent_at: emailLog.sent_at || new Date() });
          return { success: true, skipped: true };
        }
        const letterFile = path.join(UPLOADS_DIR, path.basename(job.data.approvalLetter.filename));
        if (!fs.existsSync(letterFile)) {
          // Throw → BullMQ retries; better than silently emailing without the letter.
          throw new Error(`Approval letter file missing: ${letterFile}`);
        }
        attachments = [{
          filename:    job.data.approvalLetter.displayName || path.basename(letterFile),
          path:        letterFile,
          contentType: 'application/pdf',
        }];
      }

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

      await sendStyledMail(to, subject, htmlContent, attachments);

      await emailLog.update({ status: 'SENT', sent_at: new Date() });

      if (letterApp) {
        await letterApp.update({ approval_letter_sent_at: new Date() }).catch(err =>
          console.error(`[ApplicationStatusEmailWorker] Sent letter but could not stamp approval_letter_sent_at for ${job.data.applicationId}:`, err.message)
        );
      }

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
