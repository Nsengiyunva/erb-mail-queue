// import { Worker } from 'bullmq';
// import connection from "../redis/connection.js";
// import { sendEmail, sendStyledMail } from '../utils/mailer.js';
// import path from 'path';

// const worker = new Worker(
//   'emailQueue',
//   async job => {
//     try {
//       const { to, subject, text, files } = job.data;

//       const attachments = files.map(file => ({
//         filename: path.basename(file),
//         path: file
//       }));

//       const htmlContent = `
//         <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f8f2f2; padding: 30px;">
//           <div style="max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 8px;">
//             <div style="background-color: #b30000; padding: 20px; text-align: center;">
//               <h1 style="color: #ffffff; margin: 0;">Engineers Registration Board (ERB)</h1>
//             </div>
  
//             <div style="padding: 25px;">
//               <h2>Dear Engineer, 📄</h2>
//               <p>Your professional practising license is attached to this email.</p>
//               <p>Please download and keep it safely.</p>
  
//               <p>
//                 Regards,<br/>
//                 <strong>ERB Support Team</strong>
//               </p>
//             </div>
//           </div>
//         </div>
//       `;

//       await sendStyledMail(
//         to,
//         "RE: YOUR ERB PROFESSIONAL LICENSE",
//         htmlContent,
//         attachments
//       );

//       // await sendEmail({ to, subject, text, attachments });

//     } catch (err) {
//       console.error(`Error sending email for job ${job.id}:`, err);
//       throw err; // rethrow so BullMQ can handle retries
//     }
//   },
//   {
//     // connection: emailQueue.client,
//     connection,
//     concurrency: 5 
//   }
// );

// worker.on('completed', job => {
//   console.log(`Email job ${job.id} completed for ${job.data.to}`);
// });

// worker.on('failed', (job, err) => {
//   console.error(`Email job ${job.id} failed for ${job.data.to}:`, err);
// });

// export default worker;


import { Worker } from 'bullmq';
import connection from '../redis/connection.js';
import { sendStyledMail } from '../utils/mailer.js';
import path from 'path';
import fs from 'fs/promises';
import db from '../models/index.js';

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
      job.updateProgress(5);

      if (!to) {
        throw new Error('Missing recipient email');
      }

      /**
       * Create or reuse DB log
       * (important for retries)
       */
      emailLog = await EmailLog.findOne({
        where: { job_id: job.id }
      });

      if (!emailLog) {
        emailLog = await EmailLog.create({
          job_id: job.id,
          recipient_email: to,
          registration_no: registrationNo,
          status: 'PENDING'
        });
      }

      // Validate & prepare attachments
      const attachments = [];

      for (const file of files) {
        try {
          await fs.access(file);
          attachments.push({
            filename: path.basename(file),
            path: file
          });
        } catch {
          console.warn(
            `[EmailWorker] File not found for ${to}: ${file}`
          );
        }
      }

      job.updateProgress(40);

      if (attachments.length === 0) {
        console.warn(
          `[EmailWorker] No valid attachments for ${to}`
        );
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

      job.updateProgress(70);

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

      job.updateProgress(100);

      return { success: true, to };
    } catch (err) {
      console.error(
        `[EmailWorker] Error for job ${job.id} → ${to}`,
        err
      );

      if (emailLog) {
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

