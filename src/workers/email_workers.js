import { Worker } from 'bullmq';
import emailQueue from '../queues/email_queue.js'; // make sure filename matches
import { sendEmail } from '../utils/mailer.js';
import path from 'path';

const worker = new Worker(
  'emailQueue',
  async job => {
    try {
      const { to, subject, text, files } = job.data;

      // map file paths to Nodemailer attachments
      const attachments = files.map(file => ({
        filename: path.basename(file),
        path: file
      }));

      await sendEmail({ to, subject, text, attachments });
    } catch (err) {
      console.error(`Error sending email for job ${job.id}:`, err);
      throw err; // rethrow so BullMQ can handle retries
    }
  },
  {
    connection: emailQueue.client,
    concurrency: 5 // process 5 jobs in parallel
  }
);

worker.on('completed', job => {
  console.log(`Email job ${job.id} completed for ${job.data.to}`);
});

worker.on('failed', (job, err) => {
  console.error(`Email job ${job.id} failed for ${job.data.to}:`, err);
});

export default worker;