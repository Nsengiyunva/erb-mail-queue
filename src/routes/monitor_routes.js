// routes/monitor_routes.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import fileProcessQueue from '../queues/file_process_queue.js';


const router = express.Router();
const SOURCE_DIR = '/var/ugpass/source';

await fs.mkdir(SOURCE_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, SOURCE_DIR),
  filename: (_, file, cb) => cb(null, file.originalname)
});

const upload = multer({ storage });

router.post('/upload_batch', upload.array('files', 10), async (req, res) => {
  // const batchId = `batch_${Date.now()}`;

  // const files = req.files.map(f => ({
  //   originalName: f.originalname,
  //   filename: f.filename
  // }));

  // await fileProcessQueue.add('process-batch', {
  //   batchId,
  //   files
  // }, { jobId: batchId });

  // res.json({ batchId, count: files.length });
  try {
    res.json(  {
      sucess: true,
      msssage: "Server running properly..."
    } );
  } catch (error) {
    res.json(  {
      sucess: false,
      error
    } );
  }
});


router.get('/status/:batchId', async (req, res) => {
  const batch = await FileBatch.findOne({ where: { batchId: req.params.batchId } });
  if (!batch) return res.status(404).json({ error: 'Not found' });
  res.json(batch);
});

export default router;
