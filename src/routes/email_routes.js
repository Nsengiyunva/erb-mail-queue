import express from 'express';
import fs from 'fs';
import path from 'path';
import emailQueue from '../queues/email_queues.js'; 

const router = express.Router();

router.get('/healthcheck', async ( req, res )  => {
  try {
    res.json(  {
      sucess: true,
      msssage: "Serverr running properly"
    } );
  } catch (error) {
    res.json(  {
      sucess: false,
      error
    } );
  }
} )

router.post('/send-pdfs', async (req, res) => {
  try {
    const { recipients } = req.body;
    // recipients = [{ email: "person1@example.com", registrationNo: "TR84" }, ...]

    const folderPath = '/var/ugpass/destination';
    const allFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.pdf'));

    const missingFiles = [];

    for (const recipient of recipients) {
      const matchingFile = allFiles.find(f => f.includes(recipient.registrationNo));
      if (!matchingFile) {
        console.warn(`No PDF found for ${recipient.registrationNo}`);
        missingFiles.push(recipient.registrationNo);
        continue;
      }

      const filePath = path.join(folderPath, matchingFile);

      // Add job to BullMQ queue with retry logic
      await emailQueue.add(
        'send-pdf',
        {
          to: recipient.email,
          subject: `Your PDF for ${recipient.registrationNo}`,
          text: 'Please find attached your PDF.',
          files: [filePath]
        },
        {
          attempts: 3, // Retry up to 3 times if sending fails
          backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s between retries
          removeOnComplete: true,
          removeOnFail: false
        }
      );
    }

    res.json({
      message: 'Email jobs added to queue',
      missingFiles
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to enqueue email jobs' });
  }
});

export default router;