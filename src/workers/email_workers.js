import { Worker } from 'bullmq';
import emailQueue from '../queues/email_queues.js';
import { sendEmail, sendStyledMail } from '../utils/mailer.js';
import path from 'path';

const worker = new Worker(
  'emailQueue',
  async job => {
    try {
      const { to, subject, text, files } = job.data;

      const attachments = files.map(file => ({
        filename: path.basename(file),
        path: file
      }));

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
        </div>
      `;

      await sendStyledMail(
        to,
        "RE: YOUR ERB PROFESSIONAL LICENSE",
        htmlContent,
        attachments
      );

      // await sendEmail({ to, subject, text, attachments });

    } catch (err) {
      // console.error(`Error sending email for job ${job.id}:`, err);
      throw err; // rethrow so BullMQ can handle retries
    }
  },
  {
    connection: emailQueue.client,
    concurrency: 5 
  }
);

worker.on('completed', job => {
  console.log(`Email job ${job.id} completed for ${job.data.to}`);
});

worker.on('failed', (job, err) => {
  console.error(`Email job ${job.id} failed for ${job.data.to}:`, err);
});

export default worker;