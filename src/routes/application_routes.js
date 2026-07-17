// import express from "express";
// import fs from "fs";
// import path from 'path'
// import multer from "multer";
// import { sequelize } from "../config/database.js";
// import { DataTypes } from "sequelize";
// import ApplicationModel from "../models/Application.js";
// import applicationQueue from "../queues/application_queue.js";

// const router = express.Router();
// const Application = ApplicationModel(sequelize, DataTypes);


// const UPLOADS_DIR = path.resolve("/home/user1/uploads");

// if (!fs.existsSync(UPLOADS_DIR)) {
//   fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// }

// const storage = multer.diskStorage({
//   destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
//   filename: (_req, file, cb) => {
//     const unique = `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
//     cb(null, unique);
//   },
// });

// const upload = multer({
//   storage,
//   limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
//   fileFilter: (_req, file, cb) => {
//     const ALLOWED = [
//       "application/pdf",
//       "image/jpeg",
//       "image/png",
//       "application/msword",
//       "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
//     ];
//     ALLOWED.includes(file.mimetype)
//       ? cb(null, true)
//       : cb(new Error(`File type not allowed: ${file.mimetype}`));
//   },
// })


// router.post("/submit-application", async (req, res) => {
//   const transaction = await sequelize.transaction();

//   try {
//     const payload = req.body;

//     const {
//       applicant_id,
//       email_address,
//       applicationID
//     } = payload;

//     if (!applicant_id || !email_address) {
//       return res.status(400).json({
//         message: "Applicant ID and Email Address are both required",
//       });
//     }

//     /**
//      * 1️⃣ Create or reuse application (IDEMPOTENT)
//      */
//     let application;

//     const whereClause = applicationID ? { id: applicationID }  : { applicant_id };

//     application = await Application.findOne({
//       where: whereClause,
//       transaction
//     });


//     //the switch leg-work
//     if (!application) {
//       application = await Application.create(
//         {
//           ...payload,
//           status: "PENDING",
//         },
//         { transaction }
//       );
//     } else {
//       // Optional: update draft data before queue
//       await application.update(
//         {
//           ...payload,
//           status: "PENDING",
//         },
//         { transaction }
//       );
//     }

//     /**
//      * 2️⃣ Queue processing job
//      */
//     await applicationQueue.add(
//       "process-application",
//       {
//         ...payload,
//         applicationID: application.applicationID || application.id,
//         dbId: application.id, // 🔥 important for worker reference
//       },
//       {
//         attempts: 3,
//         backoff: { type: "exponential", delay: 5000 },
//         removeOnComplete: true,
//         removeOnFail: false,
//       }
//     );

//     await transaction.commit();

//     res.status(201).json({
//       message: "Application submitted and queued successfully",
//       applicationId: application.id,
//     });

//   } catch (error) {
//     await transaction.rollback();

//     console.error("Application submission failed:", error);

//     res.status(500).json({
//       message: "Failed to submit application",
//     });
//   }
// })

// router.post(
//   "/engineer_documents",
//   upload.single("document"),
//   async (req, res) => {
//     try {
//       const { applicationID, file_title, applicant_id } = req.body;

//       // ── Validate applicationID ──────────────────────────────────────
//       const parsedID = Number(applicationID);
//       if (!applicationID || isNaN(parsedID)) {
//         if (req.file) fs.unlink(req.file.path, () => {});
//         return res.status(400).json({ message: "A valid applicationID is required" });
//       }

//       if (!req.file) {
//         return res.status(400).json({ message: "No file was uploaded" });
//       }

//       if (!file_title) {
//         fs.unlink(req.file.path, () => {});
//         return res.status(400).json({ message: "file_title is required" });
//       }

//       // ── Map file title to DB column (early — avoids wasted DB call) ─
//       const TITLE_COLUMN_MAP = {
//         "technical report": "technical_path",
//         "career report":    "career_path",
//       };

//       const normalizedTitle = file_title.toLowerCase().trim();
//       const column = TITLE_COLUMN_MAP[normalizedTitle];

//       if (!column) {
//         fs.unlink(req.file.path, () => {});
//         return res.status(400).json({
//           message: `Invalid file_title. Accepted values: ${Object.keys(TITLE_COLUMN_MAP).join(", ")}`,
//         });
//       }

//       // ── Find application — by id, fallback to applicant_id ──────────
//       let application = await Application.findOne({
//         where: { id: parsedID },
//       });

//       // Fallback: if frontend sent applicant_id instead of application id
//       if (!application && applicant_id && !isNaN(Number(applicant_id))) {
//         application = await Application.findOne({
//           where: { applicant_id: Number(applicant_id) },
//         });
//       }

//       if (!application) {
//         fs.unlink(req.file.path, () => {});
//         return res.status(404).json({ message: "Application not found" });
//       }

//       // ── Normalize file path ─────────────────────────────────────────
//       const filePath = path
//         .relative(process.cwd(), req.file.path)
//         .replace(/\\/g, "/");

//       // ── Update application ──────────────────────────────────────────
//       await application.update({ [column]: filePath });

//       // ── Success ─────────────────────────────────────────────────────
//       return res.status(200).json({
//         message:       "Document uploaded successfully",
//         applicationId: application.id,   // return the real DB id so frontend can store it
//         filePath,
//         columnUpdated: column,
//       });

//     } catch (error) {
//       if (req.file) fs.unlink(req.file.path, () => {});
//       console.error("Document upload failed:", error);
//       return res.status(500).json({
//         message: error.message || "Failed to upload document",
//       });
//     }
//   }
// )

// router.get("/get_application_files/:applicationID", async (req, res) => {
//   try {
//     const { applicationID } = req.params;

//     if (!applicationID) {
//       return res.status(400).json({
//         message: "Application ID is required",
//       });
//     }

//     const application = await Application.findOne({
//       where: { id: applicationID },
//       attributes: ["id", "applicant_id", "technical_path", "career_path"],
//     });

//     if (!application) {
//       return res.status(404).json({
//         message: "Application not found",
//       });
//     }

//     const baseUrl = `${req.protocol}://${req.get("host")}`;

//     const buildFileEntry = (filePath, tag) => {
//       if (!filePath) return null;

//       const fileName = filePath.split("/").pop(); // e.g. "1775044680791-1638_Receipt.pdf"

//       return {
//         _id:      `${applicationID}_${tag}`,
//         name:     fileName,
//         tag:      tag,
//         filePath: filePath.replace(/^\.\.\/\.\.\//, ""), // strip leading ../../ for URL use
//       };
//     };

//     const files = [
//       buildFileEntry(application.technical_path, "technical"),
//       buildFileEntry(application.career_path,    "career"),
//     ].filter(Boolean); // drop nulls for files not yet uploaded

//     res.status(200).json({
//       message: "Files fetched successfully",
//       files,
//     });

//   } catch (error) {
//     console.error("Failed to fetch application files:", error);

//     res.status(500).json({
//       message: "Failed to fetch application files",
//     });
//   }
// });


// router.get("/draft/:applicant_id", async (req, res) => {
//   try {
//     const { applicant_id } = req.params;

//     if (!applicant_id) {
//       return res.status(400).json({ message: "Applicant ID is required" });
//     }

//     const application = await Application.findOne({
//       where: { applicant_id: Number(applicant_id) },
//     });

//     if (!application) {
//       return res.status(200).json({
//         message: "No application found for this applicant",
//         application: null,
//       });
//     }

//     res.status(200).json({
//       message: "Application fetched successfully",
//       application,
//     });

//   } catch (error) {
//     console.error("Failed to fetch draft:", error);
//     res.status(500).json({ message: "Failed to fetch draft" });
//   }
// })

// // ── GET /application/:applicant_id ──────────────────────────────
// // Returns the full application record for a given applicant.
// // Used by the frontend "View my application" flow to render
// // the submitted application detail view.
// router.get("/application/:applicant_id", async (req, res) => {
//   try {
//     const applicant_id = Number(req.params.applicant_id);

//     if (!applicant_id || isNaN(applicant_id)) {
//       return res.status(400).json({ message: "A valid applicant ID is required" });
//     }

//     const application = await Application.findOne({
//       where: { applicant_id },
//     });

//     if (!application) {
//       return res.status(404).json({
//         message: "No application found for this applicant",
//         application: null,
//       });
//     }

//     // Parse JSON columns so the frontend receives arrays, not strings
//     const raw = application.toJSON();

//     const parseCol = (val) => {
//       if (!val) return [];
//       if (Array.isArray(val)) return val;
//       try { return JSON.parse(val); } catch { return []; }
//     };

//     const result = {
//       ...raw,
//       education:   parseCol(raw.education),
//       engineering: parseCol(raw.engineering),
//       training:    parseCol(raw.training),
//       positions:   parseCol(raw.positions),
//       membership:  parseCol(raw.membership),
//       sponsors:    parseCol(raw.sponsors),
//     };

//     return res.status(200).json({
//       message: "Application fetched successfully",
//       application: result,
//     });

//   } catch (error) {
//     console.error("Failed to fetch application:", error);
//     return res.status(500).json({ message: "Failed to fetch application" });
//   }
// });



// // ── GET /uploads/:filename ───────────────────────────────────────
// // Serves uploaded documents (PDFs, images) directly from disk.
// // The path stored in the DB is relative to cwd, e.g.
// //   "../../home/user1/uploads/1234567890-report.pdf"
// // The frontend hits /api/erb/uploads/:filename so we just resolve
// // the filename against UPLOADS_DIR.
// router.get("/uploads/:filename", (req, res) => {
//   const { filename } = req.params;

//   // Guard against path traversal
//   if (filename.includes("..") || filename.includes("/")) {
//     return res.status(400).json({ message: "Invalid filename" });
//   }

//   const filePath = path.join(UPLOADS_DIR, filename);

//   if (!fs.existsSync(filePath)) {
//     return res.status(404).json({ message: "File not found" });
//   }

//   // Let the browser decide whether to display inline or download.
//   // PDFs open inline; other types trigger a download prompt.
//   const ext = path.extname(filename).toLowerCase();
//   const isPdf = ext === ".pdf";

//   res.setHeader(
//     "Content-Disposition",
//     isPdf ? `inline; filename="${filename}"` : `attachment; filename="${filename}"`
//   );

//   res.sendFile(filePath);
// });

// export default router;



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
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
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
})


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

router.post(
  "/engineer_documents",
  upload.single("document"),
  async (req, res) => {
    try {
      const { applicationID, file_title, applicant_id } = req.body;

      // ── Validate applicationID ──────────────────────────────────────
      const parsedID = Number(applicationID);
      if (!applicationID || isNaN(parsedID)) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: "A valid applicationID is required" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file was uploaded" });
      }

      if (!file_title) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: "file_title is required" });
      }

      // ── Map file title to DB column (early — avoids wasted DB call) ─
      const TITLE_COLUMN_MAP = {
        "technical report":              "technical_path",
        "career report":                 "career_path",
        "uipe membership letter":        "uipe_membership_letter_path",
        "uipe membership certificate":   "uipe_membership_certificate_path",
        "academic certificates":         "academic_certificates_path",
        "academic transcripts":          "transcripts_path",
        "uneb certificates":             "uneb_certificates_path",
        "verification letter":           "verification_letters_path",
        "other qualifications":          "other_qualifications_path",
        "employment letter":             "employment_letters_path",
        "organogram":                    "organogram_path",
        "cpd records":                   "cpd_path",
        "passport photograph 1":         "passport_photo_1_path",
        "passport photograph 2":         "passport_photo_2_path",
      };

      const normalizedTitle = file_title.toLowerCase().trim();
      const column = TITLE_COLUMN_MAP[normalizedTitle];

      if (!column) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          message: `Invalid file_title. Accepted values: ${Object.keys(TITLE_COLUMN_MAP).join(", ")}`,
        });
      }

      // ── Find application — by id, fallback to applicant_id ──────────
      let application = await Application.findOne({
        where: { id: parsedID },
      });

      // Fallback: if frontend sent applicant_id instead of application id
      if (!application && applicant_id && !isNaN(Number(applicant_id))) {
        application = await Application.findOne({
          where: { applicant_id: Number(applicant_id) },
        });
      }

      if (!application) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ message: "Application not found" });
      }

      // ── Normalize file path ─────────────────────────────────────────
      const filePath = path
        .relative(process.cwd(), req.file.path)
        .replace(/\\/g, "/");

      // ── Update application ──────────────────────────────────────────
      await application.update({ [column]: filePath });

      // ── Success ─────────────────────────────────────────────────────
      return res.status(200).json({
        message:       "Document uploaded successfully",
        applicationId: application.id,   // return the real DB id so frontend can store it
        filePath,
        columnUpdated: column,
      });

    } catch (error) {
      if (req.file) fs.unlink(req.file.path, () => {});
      console.error("Document upload failed:", error);
      return res.status(500).json({
        message: error.message || "Failed to upload document",
      });
    }
  }
)

router.get("/get_application_files/:applicationID", async (req, res) => {
  try {
    const { applicationID } = req.params;

    if (!applicationID) {
      return res.status(400).json({
        message: "Application ID is required",
      });
    }

    const application = await Application.findOne({
      where: { id: applicationID },
      attributes: [
        "id", "applicant_id",
        "technical_path", "career_path",
        "uipe_membership_letter_path", "uipe_membership_certificate_path",
        "academic_certificates_path", "transcripts_path",
        "uneb_certificates_path", "verification_letters_path",
        "other_qualifications_path",
        "employment_letters_path", "organogram_path",
        "cpd_path",
        "passport_photo_1_path", "passport_photo_2_path",
      ],
    });

    if (!application) {
      return res.status(404).json({
        message: "Application not found",
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const buildFileEntry = (filePath, tag) => {
      if (!filePath) return null;

      const fileName = filePath.split("/").pop(); // e.g. "1775044680791-1638_Receipt.pdf"

      return {
        _id:      `${applicationID}_${tag}`,
        name:     fileName,
        tag:      tag,
        filePath: filePath.replace(/^\.\.\/\.\.\//, ""), // strip leading ../../ for URL use
      };
    };

    const files = [
      buildFileEntry(application.technical_path,                    "technical"),
      buildFileEntry(application.career_path,                       "career"),
      buildFileEntry(application.uipe_membership_letter_path,       "uipe_membership_letter"),
      buildFileEntry(application.uipe_membership_certificate_path,  "uipe_membership_certificate"),
      buildFileEntry(application.academic_certificates_path,        "academic_certificates"),
      buildFileEntry(application.transcripts_path,                  "transcripts"),
      buildFileEntry(application.uneb_certificates_path,            "uneb_certificates"),
      buildFileEntry(application.verification_letters_path,         "verification_letters"),
      buildFileEntry(application.other_qualifications_path,         "other_qualifications"),
      buildFileEntry(application.employment_letters_path,           "employment_letters"),
      buildFileEntry(application.organogram_path,                   "organogram"),
      buildFileEntry(application.cpd_path,                          "cpd"),
      buildFileEntry(application.passport_photo_1_path,             "passport_photo_1"),
      buildFileEntry(application.passport_photo_2_path,              "passport_photo_2"),
    ].filter(Boolean); // drop nulls for files not yet uploaded

    res.status(200).json({
      message: "Files fetched successfully",
      files,
    });

  } catch (error) {
    console.error("Failed to fetch application files:", error);

    res.status(500).json({
      message: "Failed to fetch application files",
    });
  }
});


router.get("/draft/:applicant_id", async (req, res) => {
  try {
    const { applicant_id } = req.params;

    if (!applicant_id) {
      return res.status(400).json({ message: "Applicant ID is required" });
    }

    const application = await Application.findOne({
      where: { applicant_id: Number(applicant_id) },
    });

    if (!application) {
      return res.status(200).json({
        message: "No application found for this applicant",
        application: null,
      });
    }

    res.status(200).json({
      message: "Application fetched successfully",
      application,
    });

  } catch (error) {
    console.error("Failed to fetch draft:", error);
    res.status(500).json({ message: "Failed to fetch draft" });
  }
})

// ── GET /application/:applicant_id ──────────────────────────────
// Returns the full application record for a given applicant.
// Used by the frontend "View my application" flow to render
// the submitted application detail view.
router.get("/application/:applicant_id", async (req, res) => {
  try {
    const applicant_id = Number(req.params.applicant_id);

    if (!applicant_id || isNaN(applicant_id)) {
      return res.status(400).json({ message: "A valid applicant ID is required" });
    }

    const application = await Application.findOne({
      where: { applicant_id },
    });

    if (!application) {
      return res.status(404).json({
        message: "No application found for this applicant",
        application: null,
      });
    }

    // Parse JSON columns so the frontend receives arrays, not strings
    const raw = application.toJSON();

    const parseCol = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      try { return JSON.parse(val); } catch { return []; }
    };

    const result = {
      ...raw,
      education:   parseCol(raw.education),
      engineering: parseCol(raw.engineering),
      training:    parseCol(raw.training),
      positions:   parseCol(raw.positions),
      membership:  parseCol(raw.membership),
      sponsors:    parseCol(raw.sponsors),
    };

    return res.status(200).json({
      message: "Application fetched successfully",
      application: result,
    });

  } catch (error) {
    console.error("Failed to fetch application:", error);
    return res.status(500).json({ message: "Failed to fetch application" });
  }
});




export default router;
