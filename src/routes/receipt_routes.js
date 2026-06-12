import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import { createServer } from 'http'
import { Server }       from 'socket.io'
import { sequelize } from "../config/database.js";
import ReceiptModel from "../models/Receipt.js";
import { DataTypes } from "sequelize";
import receiptQueue from "../queues/receipt_queue.js";

const router = express.Router();
const Receipt = ReceiptModel(sequelize, DataTypes);

const FILE_DIR = "/home/user1/ERB/uploads";

// Ensure upload directory exists
if (!fs.existsSync(FILE_DIR)) {
  fs.mkdirSync(FILE_DIR, { recursive: true });
}

// --------------------
// CORS (router-level)
// --------------------
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "https://registration.erb.go.ug"
  ],
  credentials: true,
};

router.use(cors(corsOptions));
router.options(/.*/, cors(corsOptions));// handle preflight at router level

// --------------------
// Multer configs
// --------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, FILE_DIR);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_");
    cb(null, `${Date.now()}_${safeName}`);
  },
});

const upload = multer({ storage });

// Receipt-specific upload naming
const storage_receipt = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, FILE_DIR);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_");
    cb(null, `wed-${Date.now()}_${safeName}`);
  },
});

const upload_receipt = multer({ storage: storage_receipt });



// --------------------
// OPTIONS handlers (IMPORTANT)
// --------------------
router.options("/upload-receipt", cors(corsOptions), (req, res) => {
  res.sendStatus(204);
});

router.options("/upload-wed-receipt", cors(corsOptions), (req, res) => {
  res.sendStatus(204);
});

// --------------------
// Routes
// --------------------
//erb-payments-stanbic
const WATCHER_SECRET = process.env.WATCHER_SECRET

// ── WebSocket server ──────────────────────────────────────────────
const httpServer = createServer(app)

export const io = new Server(httpServer, {
  cors: {
    origin:      ['http://localhost:3000', 'https://registration.erb.go.ug'],
    credentials: true,
  },
})

// Rooms keyed by transactionRef — frontend joins on payment initiation
io.on('connection', (socket) => {
  socket.on('watch:payment', ({ request_id }) => {
    if (transactionRef) {
      socket.join(`payment:${request_id}`)
      console.log(`[socket] Client watching payment:${request_id}`)
    }
  })
  socket.on('disconnect', () => {
    console.log('[socket] Client disconnected')
  })
})


router.post('/payment-update', (req, res) => {
  const secret = req.headers['x-watcher-secret']

  if (secret !== WATCHER_SECRET) {
    return res.status(403).json({ message: 'Forbidden' })
  }

  const { request_id, status, amount } = req.body

  if (!request_id || !status) {
    return res.status(400).json({ message: 'transactionRef and status required' })
  }

  // Immediately ACK the watcher — don't make VM1 wait
  res.status(200).json({ received: true })

  // Push to any browser watching this transactionRef
  io.to(`payment:${request_id}`).emit('payment:update', {
    transactionRef,
    status,
    amount,
    updatedAt,
  })

  console.log(`[erb-stanbic-payment] Relayed ${request_id} → ${status} to browser clients`)
})
/**
 * POST /upload-receipt
 */
router.post("/upload-receipt", upload.single("file"), async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const { email } = req.body;
    const file = req.file;

    if (!email || !file) {
      return res.status(400).json({
        message: "Email and file are required",
      });
    }

    const receipt = await Receipt.create(
      {
        email,
        file_name: file.filename,
        original_name: file.originalname,
        file_path: file.path,
        status: "pending",
      },
      { transaction }
    );

    await receiptQueue.add(
      "send-receipt",
      {
        receiptId: receipt.id,
        email: receipt.email,
        filePath: receipt.file_path,
        originalName: receipt.original_name,
      },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      }
    );

    await transaction.commit();

    res.status(201).json({
      message: "Receipt uploaded and queued successfully",
      receiptId: receipt.id,
    });

  } catch (error) {
    await transaction.rollback();

    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    console.error("Receipt upload failed:", error);

    res.status(500).json({
      message: "Failed to upload receipt",
    });
  }
});


/**
 * POST /upload-wed-receipt
 */
router.post(
  "/upload-wed-receipt",
  upload_receipt.single("file"),
  async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
      const { email } = req.body;
      const file = req.file;

      if (!email || !file) {
        return res.status(400).json({
          message: "Email and file are required",
        });
      }

      const receipt = await Receipt.create(
        {
          email,
          file_name: file.filename,
          original_name: file.originalname,
          file_path: file.path,
          status: "pending",
        },
        { transaction }
      );

      await receiptQueue.add(
        "send-receipt",
        {
          receiptId: receipt.id,
          email: receipt.email,
          filePath: receipt.file_path,
          originalName: receipt.original_name,
        },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: true,
          removeOnFail: false,
        }
      );

      await transaction.commit();

      res.status(201).json({
        message: "WED Receipt uploaded and queued successfully",
        receiptId: receipt.id,
      });

    } catch (error) {
      await transaction.rollback();

      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      console.error("WED receipt upload failed:", error);

      res.status(500).json({
        message: "Failed to upload receipt",
      });
    }
  }
);

export default router;