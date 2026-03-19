import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import reportQueue from '../queues/report_queue.js';

const router = express.Router();

const SOURCE_DIR = '/home/user1/ERB/uploads';

// Ensure directory exists
fs.mkdir(SOURCE_DIR, { recursive: true })
  .then(() => console.log(`SOURCE_DIR ready: ${SOURCE_DIR}`))
  .catch(err => console.error('Failed to create SOURCE_DIR:', err));

/**
 * 🧠 Safer filename generator
 */
const generateFileName = (originalName) => {
  const ext = path.extname(originalName);
  const name = path.basename(originalName, ext).replace(/\s+/g, '_');
  return `${Date.now()}_${name}${ext}`;
};

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SOURCE_DIR),
  filename: (req, file, cb) => cb(null, generateFileName(file.originalname))
});

const upload = multer({
  storage,
  limits: {
    fileSize: 30 * 1024 * 1024 // ✅ 30MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are allowed'));
    }
    cb(null, true);
  }
});


// 🚀 Upload Route (QUEUE INTEGRATED)
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No Report Uploaded'
      });
    }


    const job = await reportQueue.add({
      file_path: file.path,
      original_name: file.originalname,
      file_type: file.mimetype,
      file_size: file.size,
      row_id: req.body.row_id,
      email_address: req.body.email_address,
      user_id: req.body.user_id
    }, {
      attempts: 3, // retry if fails
      backoff: 5000 // 5 seconds
    });

    return res.json({
      success: true,
      message: 'Report uploaded and queued successfully',
      job_id: job.id,
      file: {
        name: file.originalname,
        size: file.size
      }
    });

  } catch (error) {
    console.error('Upload error:', error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

export default router;
