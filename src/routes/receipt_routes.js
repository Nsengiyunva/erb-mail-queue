// import express from "express";
// import multer from "multer";
// import fs from "fs";
// import path from "path";
// import { sequelize } from "../config/database.js";
// import ReceiptModel from "../models/Receipt.js";
// import { DataTypes } from "sequelize";
// import receiptQueue from "../queues/receipt_queue.js";

// const router = express.Router();
// const Receipt = ReceiptModel(sequelize, DataTypes);

// const FILE_DIR = "/home/user1/ERB/uploads";

// // Ensure upload directory exists
// if (!fs.existsSync(FILE_DIR)) {
//   fs.mkdirSync(FILE_DIR, { recursive: true });
// }

// // Multer config
// const storage = multer.diskStorage({
//   destination: (_req, _file, cb) => {
//     cb(null, FILE_DIR);
//   },
//   filename: (_req, file, cb) => {
//     const safeName = file.originalname.replace(/\s+/g, "_");
//     cb(null, `${Date.now()}_${safeName}`);
//   },
// });

// const upload = multer({ storage });


// //receipt uploads
// const storage_receipt = multer.diskStorage({
//   destination: (_req, _file, cb) => {
//     cb(null, FILE_DIR);
//   },
//   filename: (_req, file, cb) => {
//     const safeName = file.originalname.replace(/\s+/g, "_");
//     cb(null, `wed-${Date.now()}_${safeName}`);
//   },
// });

// const upload_receipt = multer({ storage_receipt });


// /**
//  * POST /api/receipts/upload
//  */
// router.post(
//   "/upload-receipt",
//   upload.single("file"),
//   async (req, res) => {
//     const transaction = await sequelize.transaction();

//     try {
//       const { email } = req.body;
//       const file = req.file;

//       if (!email || !file) {
//         return res.status(400).json({
//           message: "Email and file are required",
//         });
//       }

//       // 1️⃣ Create receipt record
//       const receipt = await Receipt.create(
//         {
//           email,
//           file_name: file.filename,
//           original_name: file.originalname,
//           file_path: file.path,
//           status: "pending",
//         },
//         { transaction }
//       );

//       // 2️⃣ Queue email job
//       await receiptQueue.add(
//         "send-receipt",
//         {
//           receiptId: receipt.id,
//           email: receipt.email,
//           filePath: receipt.file_path,
//           originalName: receipt.original_name,
//         },
//         {
//           attempts: 3,
//           backoff: { type: "exponential", delay: 5000 },
//           removeOnComplete: true,
//           removeOnFail: false,
//         }
//       );

//       await transaction.commit();

//       res.status(201).json({
//         message: "Receipt uploaded and queued successfully",
//         receiptId: receipt.id,
//       });
//     } catch (error) {
//       await transaction.rollback();

//       // Cleanup file if DB fails
//       if (req.file?.path && fs.existsSync(req.file.path)) {
//         fs.unlinkSync(req.file.path);
//       }

//       console.error("Receipt upload failed:", error);
//       res.status(500).json({
//         message: "Failed to upload receipt",
//       });
//     }
//   }
// );


// router.post(
//   "/upload-wed-receipt",
//   upload_receipt.single("file"),
//   async (req, res) => {
//     const transaction = await sequelize.transaction();

//     try {
//       const { email } = req.body;
//       const file = req.file;

//       if (!email || !file) {
//         return res.status(400).json({
//           message: "Email and file are required",
//         });
//       }

//       // 1️⃣ Create receipt record
//       const receipt = await Receipt.create(
//         {
//           email,
//           file_name: file.filename,
//           original_name: file.originalname,
//           file_path: file.path,
//           status: "pending",
//         },
//         { transaction }
//       );

//       // 2️⃣ Queue email job
//       await receiptQueue.add(
//         "send-receipt",
//         {
//           receiptId: receipt.id,
//           email: receipt.email,
//           filePath: receipt.file_path,
//           originalName: receipt.original_name,
//         },
//         {
//           attempts: 3,
//           backoff: { type: "exponential", delay: 5000 },
//           removeOnComplete: true,
//           removeOnFail: false,
//         }
//       );

//       await transaction.commit();

//       res.status(201).json({
//         message: "WED Receipt uploaded and queued successfully",
//         receiptId: receipt.id,
//       });
//     } catch (error) {
//       await transaction.rollback();

//       // Cleanup file if DB fails
//       if (req.file?.path && fs.existsSync(req.file.path)) {
//         fs.unlinkSync(req.file.path);
//       }

//       // console.error("Receipt upload failed:", error);
//       res.status(500).json({
//         message: "Failed to upload receipt",
//       });
//     }
//   }
// );




// export default router;


import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
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
router.options("*", cors(corsOptions)); // handle preflight at router level

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