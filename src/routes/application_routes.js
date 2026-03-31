import express from "express";
import fs from "fs";
import path from 'path'
import multer from "multer";
import { sequelize } from "../config/database.js";
import { DataTypes } from "sequelize";
import ApplicationModel from "../models/Application.js";
import applicationQueue from "../queues/application_queue.js";

const router = express.Router();
const Application = ApplicationModel(sequelize, DataTypes);


const UPLOADS_DIR = path.resolve("/home/user1/uploads");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ALLOWED = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    ALLOWED.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});


/**
 * POST /api/applications/submit
 */
router.post("/submit-application", async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const payload = req.body;

    const {
      applicant_id,
      email_address,
      applicationID
    } = payload;

    if (!applicant_id || !email_address) {
      return res.status(400).json({
        message: "Applicant ID and Email Address are both required",
      });
    }

    /**
     * 1️⃣ Create or reuse application (IDEMPOTENT)
     */
    let application;

    const whereClause = applicationID ? { id: applicationID }  : { applicant_id };

    application = await Application.findOne({
      where: whereClause,
      transaction
    });


    //the switch leg-work
    if (!application) {
      application = await Application.create(
        {
          ...payload,
          status: "PENDING",
        },
        { transaction }
      );
    } else {
      // Optional: update draft data before queue
      await application.update(
        {
          ...payload,
          status: "PENDING",
        },
        { transaction }
      );
    }

    /**
     * 2️⃣ Queue processing job
     */
    await applicationQueue.add(
      "process-application",
      {
        ...payload,
        applicationID: application.applicationID || application.id,
        dbId: application.id, // 🔥 important for worker reference
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
      message: "Application submitted and queued successfully",
      applicationId: application.id,
    });

  } catch (error) {
    await transaction.rollback();

    console.error("Application submission failed:", error);

    res.status(500).json({
      message: "Failed to submit application",
    });
  }
})


// router.post(
//   "/engineer_documents",
//   upload.single("document"), // single file under the key "document"
//   async (req, res) => {
//     try {
//       const { applicationID, file_title } = req.body;

//       // ── Validate inputs ───────────────────────────────────────────────────
//       if (!applicationID) {
//         req.file && fs.unlink(req.file.path, () => {});
//         return res.status(400).json({ message: "applicationID is required" });
//       }

//       if (!req.file) {
//         return res.status(400).json({ message: "No file was uploaded" });
//       }

//       // ── Find the application ──────────────────────────────────────────────
//       const application = await Application.findOne({
//         where: { id: applicationID },
//       });

//       if (!application) {
//         fs.unlink(req.file.path, () => {});
//         return res.status(404).json({ message: "Application not found" });
//       }

//       const filePath = path
//         .relative(process.cwd(), req.file.path)
//         .replace(/\\/g, "/");

//       const TITLE_COLUMN_MAP = {
//         "technical report": "technical_path",
//         "career report":    "career_path",
//       };

//       const column = TITLE_COLUMN_MAP[file_title?.toLowerCase().trim()];

//       if (!column) {
//         fs.unlink(req.file.path, () => {});
//         return res.status(400).json({
//           message: `Invalid file_title. Accepted values: ${Object.keys(TITLE_COLUMN_MAP).join(", ")}`,
//         });
//       }

//       await application.update({ [column]: filePath });

//       res.status(200).json({
//         message: "Document uploaded successfully",
//         filePath,
//         allFilePaths: [...existing, filePath],
//       });
//     } catch (error) {
//       req.file && fs.unlink(req.file.path, () => {});
//       console.error("Document upload failed:", error);
//       res.status(500).json({ message: "Failed to upload document" });
//     }
//   }
// )

router.post(
  "/engineer_documents",
  upload.single("document"),
  async (req, res) => {
    try {
      const { applicationID, file_title } = req.body;

      // ── Validate inputs ─────────────────────────────────────────────
      if (!applicationID) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: "applicationID is required" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file was uploaded" });
      }

      if (!file_title) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: "file_title is required" });
      }

      // ── Find the application ────────────────────────────────────────
      const application = await Application.findOne({
        where: { id: Number(applicationID) }, // ensure correct type
      });

      if (!application) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ message: "Application not found" });
      }

      // ── Normalize file path ─────────────────────────────────────────
      const filePath = path
        .relative(process.cwd(), req.file.path)
        .replace(/\\/g, "/");

      // ── Map file title to DB column ─────────────────────────────────
      const TITLE_COLUMN_MAP = {
        "technical report": "technical_path",
        "career report": "career_path",
      };

      const normalizedTitle = file_title.toLowerCase().trim();
      const column = TITLE_COLUMN_MAP[normalizedTitle];

      if (!column) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          message: `Invalid file_title. Accepted values: ${Object.keys(TITLE_COLUMN_MAP).join(", ")}`,
        });
      }

      // ── Update application ──────────────────────────────────────────
      await application.update({ [column]: filePath });

      // ── Success response ────────────────────────────────────────────
      return res.status(200).json({
        message: "Document uploaded successfully",
        filePath,
        columnUpdated: column,
      });

    } catch (error) {
      // Clean up uploaded file on failure
      if (req.file) fs.unlink(req.file.path, () => {});

      console.error("Document upload failed:", error);

      return res.status(500).json({
        message: error.message || "Failed to upload document",
      });
    }
  }
);


router.get("/draft/:applicant_id", async (req, res) => {
  try {
    const { applicant_id } = req.params;

    if (!applicant_id) {
      return res.status(400).json({ message: "Applicant ID is required" });
    }

    const application = await Application.findOne({
      where: { applicant_id: Number(applicant_id) }
    })

    if (!application) {
      return res.status(404).json({ message: "No application found for this applicant" });
    }

    res.status(200).json({
      message: "Draft fetched successfully",
      application,
    });

  } catch (error) {
    console.error("Failed to fetch draft:", error);
    res.status(500).json({ message: "Failed to fetch draft" });
  }
})



export default router;