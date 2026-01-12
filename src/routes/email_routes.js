// import express from 'express';
// // import fs from 'fs';
// import fs from 'fs/promises';
// import path from 'path';
// import emailQueue from '../queues/email_queues.js'; 

// import multer from 'multer';
// // import path from 'path';
// // import fs from 'fs/promises';
// import fileProcessQueue from '../queues/file_process_queue.js';

// const router = express.Router();

// //----
// const SOURCE_DIR = '/var/ugpass/source';

// await fs.mkdir(SOURCE_DIR, { recursive: true });

// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     if (!cb) throw new Error("Multer callback missing");
//     cb(null, SOURCE_DIR);
//   },
//   filename: (req, file, cb) => {
//     if (!cb) throw new Error("Multer callback missing");
//     cb(null, file.originalname);
//   }
// });

// const upload = multer({ storage });

// //-----

// router.get('/healthcheck', async ( req, res )  => {
//   try {
//     res.json(  {
//       success: true,
//       msssage: "Server running properly..."
//     } );
//   } catch (error) {
//     res.json(  {
//       success: false,
//       error
//     } );
//   }
// } )

// router.post('/send-pdfs', async (req, res) => {
//   try {
//     const { recipients } = req.body;
//     // recipients = [{ email: "person1@example.com", registrationNo: "TR84" }, ...]

//     const folderPath = '/var/ugpass/destination';
//     const allFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.pdf'));

//     const missingFiles = [];

//     for (const recipient of recipients) {
//       const matchingFile = allFiles.find(f => f.includes(recipient.registrationNo));
//       if (!matchingFile) {
//         console.warn(`No PDF found for ${recipient.registrationNo}`);
//         missingFiles.push(recipient.registrationNo);
//         continue;
//       }

//       const filePath = path.join(folderPath, matchingFile);

//       // Add job to BullMQ queue with retry logic
//       await emailQueue.add(
//         'send-pdf',
//         {
//           to: recipient.email,
//           subject: `Your PDF for ${recipient.registrationNo}`,
//           text: 'Please find attached your PDF.',
//           files: [filePath]
//         },
//         {
//           attempts: 3, // Retry up to 3 times if sending fails
//           backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s between retries
//           removeOnComplete: true,
//           removeOnFail: false
//         }
//       );
//     }

//     res.json({
//       message: 'Email jobs added to queue',
//       missingFiles
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: 'Failed to enqueue email jobs' });
//   }
// });

// router.get('/healthcheck_3', async (req, res) => {
//   res.json({
//     success: true,
//     message: "UPLOADS is running properly..."
//   });
// });


// //testing this out
// router.get('/healthcheck_2', async (req, res) => {
//   // const batchId = `batch_${Date.now()}`;

//   // const files = req.files.map(f => ({
//   //   originalName: f.originalname,
//   //   filename: f.filename
//   // }));

//   // await fileProcessQueue.add('process-batch', {
//   //   batchId,
//   //   files
//   // }, { jobId: batchId });

//   // res.json({ batchId, count: files.length });
//   res.json(  {
//     success: true,
//     msssage: "UPLOADS is running properly..."
//   } );
// });

// export default router;


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
