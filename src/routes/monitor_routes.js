// // routes/monitor_routes.js
// import express from 'express';
// import multer from 'multer';
// import path from 'path';
// import fs from 'fs/promises';
// import fileProcessQueue from '../queues/file_process_queue.js';


// const router = express.Router();
// const SOURCE_DIR = '/var/ugpass/source';

// await fs.mkdir(SOURCE_DIR, { recursive: true });

// const storage = multer.diskStorage({
//   destination: (_, __, cb) => cb(null, SOURCE_DIR),
//   filename: (_, file, cb) => cb(null, file.originalname)
// });

// const upload = multer({ storage });

// router.post('/upload_batch', upload.array('files', 10), async (req, res) => {
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
//   try {
//     res.json(  {
//       sucess: true,
//       msssage: "Server running properly..."
//     } );
//   } catch (error) {
//     res.json(  {
//       sucess: false,
//       error
//     } );
//   }
// });


// router.get('/status/:batchId', async (req, res) => {
//   const batch = await FileBatch.findOne({ where: { batchId: req.params.batchId } });
//   if (!batch) return res.status(404).json({ error: 'Not found' });
//   res.json(batch);
// });

// export default router;


// routes/monitor_routes.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import fileProcessQueue from '../queues/file_process_queue.js';
import { FileBatch } from '../models/index.js'; // Sequelize model

const router = express.Router();

// Source directory for uploaded files
const SOURCE_DIR = '/var/ugpass/source';
await fs.mkdir(SOURCE_DIR, { recursive: true });

// Configure multer
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, SOURCE_DIR),
  filename: (_, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

router.get('/healthcheck_2', async (req, res) => {
  res.json({ success: true, message: "UPLOADS is running properly..." });
});

router.get('/healthcheck_3', async (req, res) => {
  res.json({ success: true, message: "Another upload check OK" });
});

// ========================
// Upload batch endpoint
// ========================
router.post('/upload_batch', upload.array('files', 10), async (req, res) => {
  try {
    const batchId = `batch_${Date.now()}`;
    const uploadedFiles = req.files.map(file => ({
      originalName: file.originalname,
      filename: file.filename,
      path: file.path,
      size: file.size,
      mimetype: file.mimetype
    }));

    // Add a job to the file process queue
    await fileProcessQueue.add('process-batch', {
      batchId,
      files: uploadedFiles
    }, { jobId: batchId });

    res.json({
      success: true,
      batchId,
      uploadedFilesCount: uploadedFiles.length,
      message: 'Batch uploaded and queued for processing'
    });
  } catch (error) {
    console.error('Upload batch error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================
// Batch status endpoint
// ========================
router.get('/status/:batchId', async (req, res) => {
  try {
    const batch = await FileBatch.findOne({ where: { batchId: req.params.batchId } });

    if (!batch) {
      return res.status(404).json({ success: false, error: 'Batch not found' });
    }

    res.json({
      success: true,
      batch
    });
  } catch (error) {
    console.error('Batch status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
