import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import emailQueue from '../queues/email_queues.js';
// import fileProcessQueue from '../queues/file_process_queue.js';

const router = express.Router();

const SOURCE_DIR = '/var/ugpass/source';

// Ensure source directory exists
fs.mkdir(SOURCE_DIR, { recursive: true })
  .then(() => console.log(`SOURCE_DIR ready: ${SOURCE_DIR}`))
  .catch(err => console.error('Failed to create SOURCE_DIR:', err));

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SOURCE_DIR),
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({ storage });

// Healthcheck routes
router.get('/healthcheck', async (req, res) => {
  res.json({ success: true, message: "Server running properly..." });
});

router.post('/send-pdfs', async (req, res) => {
  try {
    const { recipients } = req.body;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Recipients array is required' });
    }

    const folderPath = '/var/ugpass/destination';

    // Read PDFs ONCE
    const allFiles = await fs.readdir(folderPath);

    // Only allow numeric PDFs like 639.pdf
    const pdfFiles = allFiles.filter(file => /^\d+\.pdf$/.test(file));

    if (pdfFiles.length !== new Set(pdfFiles).size) {
      throw new Error('Duplicate PDF filenames detected');
    }    

    // Map: filename -> absolute path
    const pdfMap = new Map();
    for (const file of pdfFiles) {
      pdfMap.set(file, path.join(folderPath, file));
    }

    const jobs = [];
    const missingFiles = [];

    for (const recipient of recipients) {
      if (!recipient?.email || !recipient?.registrationNo) {
        continue;
      }

      // Normalize registration number
      const regNo = String(recipient.registrationNo).trim();
      const expectedFilename = `${regNo}.pdf`;

      const filePath = pdfMap.get(expectedFilename);

      if (!filePath) {
        missingFiles.push(regNo);
        continue;
      }

      jobs.push({
        name: 'sendEmail',
        data: {
          to: recipient.email,
          registrationNo: regNo,
          files: [filePath]
        },
        opts: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 3000
          },
          removeOnComplete: true,
          removeOnFail: false
        }
      });
    }

    if (jobs.length === 0) {
      return res.status(400).json({
        error: 'No valid email jobs created',
        missingFiles
      });
    }

    // BULK enqueue (FAST)
    await emailQueue.addBulk(jobs);

    return res.status(202).json({
      status: 'queued',
      totalRecipients: recipients.length,
      queued: jobs.length,
      missingFiles
    });
  } catch (err) {
    console.error('[send-pdfs]', err);
    return res.status(500).json({
      error: 'Failed to enqueue email jobs'
    });
  }
});


export default router;
