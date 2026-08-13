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
import { DataTypes, Op } from "sequelize";
import ApplicationModel from "../models/Application.js";
import applicationQueue from "../queues/application_queue.js";
import { PaymentTransaction, normaliseStatus } from "../controllers/receipt-controller.js";

const router = express.Router();
const Application = ApplicationModel(sequelize, DataTypes);

const parseJsonCol = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return []; }
};

// ── Effective status ─────────────────────────────────────────────
// Policy (shared with application_worker.js and the frontend): an
// attached recommendation letter IS a sponsor's approval — there's no
// separate confirmation step. New submissions get this applied at
// creation time by the worker, but applications submitted before that
// rule shipped are still sitting on the DB with status
// AWAITING_SPONSOR_APPROVAL even though every sponsor already has a
// letter on file. Rather than require a one-off migration, every read
// path recomputes the true status here — and opportunistically writes
// the correction back (fire-and-forget) so it only needs recomputing
// once per stale row.
function computeEffectiveStatus(raw) {
  if (raw.status !== "AWAITING_SPONSOR_APPROVAL") {
    return { status: raw.status || "PENDING", sponsors: raw.sponsors, changed: false };
  }
  const sponsors = parseJsonCol(raw.sponsors);
  const allSigned = sponsors.length > 0 && sponsors.every((sp) => !!sp?.recommendation_letter_path);
  if (!allSigned) {
    return { status: raw.status || "PENDING", sponsors: raw.sponsors, changed: false };
  }
  const signedSponsors = sponsors.map((sp) => ({
    ...sp,
    status: "APPROVED",
    approved_at: sp.approved_at || new Date().toISOString(),
  }));
  return { status: "SPONSOR_APPROVED", sponsors: JSON.stringify(signedSponsors), changed: true };
}

// Read-only call sites (registry list, detail fetch) use this — it persists
// the correction as a fire-and-forget write, since nothing else in those
// requests writes to the same row afterward. board_approve deliberately
// does NOT use this wrapper: it needs the pure computation so it can fold
// the sponsor correction into its own single atomic update, rather than
// risking this fire-and-forget write landing after (and clobbering) the
// board-approval write.
function deriveEffectiveStatus(row, raw) {
  const effective = computeEffectiveStatus(raw);
  if (effective.changed) {
    row.update({ status: effective.status, sponsors: effective.sponsors }).catch((err) =>
      console.error(`[application_routes] Failed to self-heal status for application ${raw.id}:`, err.message)
    );
  }
  return effective;
}


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
  let committed = false;

  try {
    const payload = req.body;

    // req.body can come back undefined (not even {}) when express.json()
    // didn't parse the request at all — most commonly because the
    // incoming Content-Type header wasn't application/json (missing,
    // wrong value, or stripped by a proxy), or the body exceeded the
    // parser's size limit. Guard instead of crashing, and log enough to
    // diagnose which of those it is next time.
    if (!payload || typeof payload !== "object") {
      console.error(
        "[submit-application] req.body missing/invalid — Content-Type:",
        req.headers["content-type"],
        "Content-Length:", req.headers["content-length"]
      );
      await transaction.rollback();
      return res.status(400).json({
        message: "Request body missing or not valid JSON. Please check your connection and try again.",
      });
    }

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

    // Commit the save now — this is the part that actually matters to the
    // applicant (having an applicationID to keep working against). It must
    // not be rolled back just because a downstream, best-effort step (the
    // background processing queue, below) has trouble.
    await transaction.commit();
    committed = true;

    /**
     * 2️⃣ Queue processing job — only for a real final submission.
     * Every step of the wizard (Start, Section A, B, C, D) calls this same
     * endpoint to autosave a draft; only draft_type === "COMPLETE" is an
     * actual submission that needs certificate/notification processing.
     * Queueing on every autosave was unnecessary load on Redis/BullMQ, and
     * — because it used to happen *inside* the same DB transaction — any
     * queue hiccup (e.g. Redis unreachable) rolled back the save entirely,
     * wiping out the applicationID the frontend had just been given. That
     * silent rollback is what caused "Application ID not found" further
     * into the wizard.
     */
    if (String(payload?.draft_type).toUpperCase() === "COMPLETE") {
      try {
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
      } catch (queueError) {
        // The application record is already safely saved and committed —
        // don't fail the request over a queueing problem. Log it so it can
        // be reprocessed/investigated, but still tell the applicant their
        // submission was received.
        console.error("Failed to queue application for processing (record was still saved):", queueError);
      }
    }

    // Return the full saved row — not just the id. The frontend's autosave
    // flow (every "Proceed" click on Section A/B/C/D) replaces its whole
    // `state.draft` with this response body. If we only send back
    // { message, applicationId }, state.draft collapses to that on every
    // save, and Formik's `enableReinitialize` — watching a derived
    // `initialValues` that reads from state.draft — resets the visible
    // form back to blank for every field not in this tiny payload
    // (first_name, surname, email_address, type, etc). The wizard's next
    // save then persists those now-blank fields right back over the DB,
    // which is what was erasing earlier steps' input. Parse the JSON text
    // columns the same way GET /application/:applicant_id does, so the
    // frontend always receives arrays for education/engineering/etc.
    const rawApplication = application.toJSON();
    const parseJsonColumn = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      try { return JSON.parse(val); } catch { return []; }
    };
    const fullApplication = {
      ...rawApplication,
      education:   parseJsonColumn(rawApplication.education),
      engineering: parseJsonColumn(rawApplication.engineering),
      training:    parseJsonColumn(rawApplication.training),
      positions:   parseJsonColumn(rawApplication.positions),
      membership:  parseJsonColumn(rawApplication.membership),
      sponsors:    parseJsonColumn(rawApplication.sponsors),
    };

    res.status(201).json({
      message: "Application submitted and queued successfully",
      applicationId: application.id,
      application: fullApplication,
    });

  } catch (error) {
    if (!committed) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        console.error("Rollback also failed:", rollbackError);
      }
    }

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
      // Store just the filename (not a cwd-relative path). multer already
      // writes every upload into UPLOADS_DIR, and the file is always
      // served back from GET /api/erb/uploads/:filename — a path relative
      // to process.cwd() (e.g. "../../uploads/x.pdf") is deployment-
      // fragile (breaks if the process's working directory ever changes)
      // and, worse, browsers silently normalize away leading "../"
      // segments when it's concatenated into a URL, which is what was
      // producing 404s on the frontend.
      const filePath = path.basename(req.file.path);

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

// ── POST /sponsor_document ──────────────────────────────────────
// Uploads a sponsor's signed & stamped recommendation letter.
// Unlike /engineer_documents, this does NOT write to a fixed DB
// column — the returned filePath is stored by the frontend directly
// on the corresponding entry inside the `sponsors` JSON array, which
// is already persisted as part of the normal draft save/update flow.
router.post(
  "/sponsor_document",
  upload.single("document"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file was uploaded" });
      }

      // Store just the filename — see the matching note in
      // /engineer_documents above for why a cwd-relative path is fragile.
      const filePath = path.basename(req.file.path);

      return res.status(200).json({
        message:  "Recommendation letter uploaded successfully",
        filePath,
      });

    } catch (error) {
      if (req.file) fs.unlink(req.file.path, () => {});
      console.error("Sponsor document upload failed:", error);
      return res.status(500).json({
        message: error.message || "Failed to upload recommendation letter",
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



// ── GET /sponsor_requests/:sponsor_id ────────────────────────────
// Returns every submitted application that named this engineer as a
// sponsor, along with just that sponsor's own entry from the
// application's `sponsors` array (name, discipline, recommendation
// letter, approval status) so the sponsor dashboard doesn't need to
// know about anyone else nominated on the same application.
//
// `sponsors` is a JSON TEXT column, so an exact-value SQL match isn't
// possible — the LIKE filters down to rows that plausibly contain this
// id, then each candidate is JSON-parsed and checked precisely (the
// LIKE alone could false-positive, e.g. sponsor_id 1 inside "id":12).
router.get("/sponsor_requests/:sponsor_id", async (req, res) => {
  try {
    const sponsorId = req.params.sponsor_id;

    if (!sponsorId) {
      return res.status(400).json({ message: "A valid sponsor ID is required" });
    }

    // Only applications that have actually been submitted — autosaved
    // drafts (status "PENDING") never reach a sponsor's dashboard.
    const SUBMITTED_STATUSES = [
      "AWAITING_SPONSOR_APPROVAL",
      "SPONSOR_APPROVED",
      "BOARD_APPROVED",
      "REGISTERED",
      "COMPLETED",
    ];

    const candidates = await Application.findAll({
      where: {
        status: { [Op.in]: SUBMITTED_STATUSES },
        sponsors: { [Op.like]: `%"id":${sponsorId}%` },
      },
    });

    const parseCol = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      try { return JSON.parse(val); } catch { return []; }
    };

    const requests = candidates
      .map((app) => {
        const raw      = app.toJSON();
        const sponsors = parseCol(raw.sponsors);
        const mine      = sponsors.find(
          (sp) => String(sp?.id) === String(sponsorId)
        );
        if (!mine) return null; // LIKE false-positive — discard

        return {
          applicationID:  raw.id,
          applicant_name: raw.name || [raw.first_name, raw.other_names, raw.surname].filter(Boolean).join(" "),
          applicant_email:raw.email_address,
          application_type: raw.type,
          application_status: raw.status,
          submitted_at:   raw.updated_at || raw.created_at,
          sponsor: {
            status: mine.status || "PENDING",
            recommendation_letter_path: mine.recommendation_letter_path || null,
            recommendation_letter_name: mine.recommendation_letter_name || null,
            approved_at: mine.approved_at || null,
          },
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      message: "Sponsor requests fetched successfully",
      requests,
    });
  } catch (error) {
    console.error("Failed to fetch sponsor requests:", error);
    return res.status(500).json({ message: "Failed to fetch sponsor requests" });
  }
});

// ── POST /sponsor_approve ────────────────────────────────────────
// A sponsor confirms their recommendation. There is no separate upload
// step here by design — the applicant's own recommendation-letter
// attachment (already required before they could submit) IS what the
// sponsor is confirming, so approval is just a status flip on that
// sponsor's entry inside the application's `sponsors` array.
// Once every nominated sponsor has approved, the application itself
// moves from AWAITING_SPONSOR_APPROVAL → SPONSOR_APPROVED so it appears
// on the ERB board's docket.
router.post("/sponsor_approve", async (req, res) => {
  try {
    const { applicationID, sponsor_id } = req.body || {};

    if (!applicationID || !sponsor_id) {
      return res.status(400).json({ message: "applicationID and sponsor_id are both required" });
    }

    const application = await Application.findOne({ where: { id: applicationID } });

    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const parseCol = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      try { return JSON.parse(val); } catch { return []; }
    };

    const sponsors = parseCol(application.sponsors);
    const index    = sponsors.findIndex((sp) => String(sp?.id) === String(sponsor_id));

    if (index === -1) {
      return res.status(404).json({ message: "You are not listed as a sponsor on this application" });
    }

    if (!sponsors[index].recommendation_letter_path) {
      return res.status(400).json({
        message: "No recommendation letter is attached for this sponsor — nothing to approve.",
      });
    }

    if (sponsors[index].status === "APPROVED") {
      return res.status(200).json({
        message: "Already approved",
        application_status: application.status,
      });
    }

    sponsors[index] = {
      ...sponsors[index],
      status: "APPROVED",
      approved_at: new Date().toISOString(),
    };

    const allApproved = sponsors.length > 0 && sponsors.every((sp) => sp?.status === "APPROVED");

    await application.update({
      sponsors: JSON.stringify(sponsors),
      ...(allApproved && application.status === "AWAITING_SPONSOR_APPROVAL"
        ? { status: "SPONSOR_APPROVED" }
        : {}),
    });

    return res.status(200).json({
      message: "Recommendation approved successfully",
      application_status: application.status,
      all_sponsors_approved: allApproved,
    });
  } catch (error) {
    console.error("Failed to approve sponsor recommendation:", error);
    return res.status(500).json({ message: "Failed to approve sponsor recommendation" });
  }
});

// ── GET /registry ─────────────────────────────────────────────────
// Admin-facing table of every genuinely submitted application (i.e.
// draft_type "COMPLETE" — excludes in-progress autosaved drafts, which
// always carry status "PENDING" and were never meant to be reviewed).
// Each row is enriched with its payment status, looked up from
// PaymentTransaction by application_id since payment isn't tracked as a
// column on Application itself.
router.get("/registry", async (req, res) => {
  try {
    const page    = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 15, 1), 100);
    const search  = (req.query.search || "").trim();
    const status  = (req.query.status || "").trim().toUpperCase();

    // status=DRAFT is a special case: it means "show in-progress drafts",
    // i.e. everything that is NOT yet a genuine final submission — the
    // opposite filter from every other tab, which all look at draft_type
    // "COMPLETE" and then narrow by pipeline status.
    const where = status === "DRAFT"
      ? { draft_type: { [Op.ne]: "COMPLETE" } }
      : { draft_type: "COMPLETE", ...(status ? { status } : {}) };

    if (search) {
      where[Op.or] = [
        { name:           { [Op.like]: `%${search}%` } },
        { first_name:     { [Op.like]: `%${search}%` } },
        { surname:        { [Op.like]: `%${search}%` } },
        { email_address:  { [Op.like]: `%${search}%` } },
        { type:           { [Op.like]: `%${search}%` } },
      ];
    }

    const { rows, count } = await Application.findAndCountAll({
      where,
      order: [["updated_at", "DESC"]],
      limit:  perPage,
      offset: (page - 1) * perPage,
    });

    // ── Payment lookup ─────────────────────────────────────────────
    const appIds = rows.map((r) => String(r.id));
    const payments = appIds.length
      ? await PaymentTransaction.findAll({ where: { application_id: { [Op.in]: appIds } } })
      : [];

    // Keep only the most recent transaction per application (an applicant
    // may have retried payment more than once).
    const latestPaymentByApp = {};
    for (const p of payments) {
      const existing = latestPaymentByApp[p.application_id];
      const pTime = new Date(p.updatedAt || p.createdAt || 0);
      const eTime = existing ? new Date(existing.updatedAt || existing.createdAt || 0) : null;
      if (!existing || pTime > eTime) latestPaymentByApp[p.application_id] = p;
    }

    const records = rows.map((row) => {
      const raw     = row.toJSON();
      const payment = latestPaymentByApp[String(raw.id)];
      const effective = deriveEffectiveStatus(row, raw);
      return {
        id:                raw.id,
        applicant_name:    raw.name || [raw.first_name, raw.other_names, raw.surname].filter(Boolean).join(" ") || "(unnamed draft)",
        email:             raw.email_address,
        type:              raw.type,
        status:            effective.status,
        is_draft:          raw.draft_type !== "COMPLETE",
        payment_status:    payment ? normaliseStatus(payment.status) : "NOT_PAID",
        amount:            payment?.amount ?? null,
        submitted_at:      raw.updated_at || raw.created_at,
      };
    });

    return res.status(200).json({
      message: "Applications fetched successfully",
      records,
      pagination: {
        currentPage:  page,
        totalPages:   Math.max(Math.ceil(count / perPage), 1),
        totalRecords: count,
        perPage,
      },
    });
  } catch (error) {
    console.error("Failed to fetch application registry:", error);
    return res.status(500).json({ message: "Failed to fetch applications" });
  }
});

// ── GET /:id ──────────────────────────────────────────────────────
// Full detail fetch for the admin "Submitted Applications" table's
// View action — includes the parsed section data (education, engineering,
// etc.), sponsors, and every attached-document path so the frontend can
// render preview links without a second round trip.
// NOTE: matched last among GET routes with a path param so it doesn't
// shadow more specific routes like /registry, /sponsor_requests/:id, etc.
// (Express matches top-down; this is intentionally placed after those.)
// NOTE: deliberately a plain `/:id`, not `/:id(\d+)` — Express 5's
// path-to-regexp (v6+) dropped support for inline regex constraints in
// path strings; using that syntax throws at route-registration time,
// which crashes the whole process on startup (every route in this file
// returns 502, not just this one). Numeric validation happens inside
// the handler instead.
router.get("/:id", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ message: "A valid numeric application ID is required" });
  }
  try {
    const application = await Application.findOne({ where: { id: req.params.id } });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const parseCol = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      try { return JSON.parse(val); } catch { return []; }
    };

    const raw = application.toJSON();

    const DOCUMENT_FIELDS = [
      { key: "technical_path",                   label: "Technical Report" },
      { key: "career_path",                      label: "Career Summary Report" },
      { key: "uipe_membership_letter_path",       label: "UIPE Membership Letter" },
      { key: "uipe_membership_certificate_path",  label: "UIPE Membership Certificate" },
      { key: "academic_certificates_path",        label: "Academic Certificates" },
      { key: "transcripts_path",                  label: "Academic Transcripts" },
      { key: "uneb_certificates_path",             label: "UNEB Certificates" },
      { key: "verification_letters_path",          label: "UNEB Verification Letter(s)" },
      { key: "other_qualifications_path",          label: "Other Qualifications" },
      { key: "employment_letters_path",            label: "Employment Letter(s) / Service Contract(s)" },
      { key: "organogram_path",                    label: "Organogram of Current Employer" },
      { key: "cpd_path",                            label: "CPD Evidence" },
      { key: "passport_photo_1_path",               label: "Passport Photograph 1" },
      { key: "passport_photo_2_path",               label: "Passport Photograph 2" },
    ];

    const documents = DOCUMENT_FIELDS
      .filter(d => !!raw[d.key])
      .map(d => ({ label: d.label, path: raw[d.key] }));

    const sponsors = parseCol(raw.sponsors).map(sp => ({
      ...sp,
      // Same policy as everywhere else: letter attached = signed.
      signed: !!sp?.recommendation_letter_path,
    }));

    const effective = deriveEffectiveStatus(application, raw);

    return res.status(200).json({
      message: "Application fetched successfully",
      application: {
        ...raw,
        status:      effective.status,
        education:   parseCol(raw.education),
        engineering: parseCol(raw.engineering),
        training:    parseCol(raw.training),
        positions:   parseCol(raw.positions),
        membership:  parseCol(raw.membership),
        sponsors,
        documents,
      },
    });
  } catch (error) {
    console.error("Failed to fetch application detail:", error);
    return res.status(500).json({ message: "Failed to fetch application" });
  }
});

// ── POST /board_approve ──────────────────────────────────────────
// Lets a Registration-level admin approve an application on behalf of
// the Board (used when the actual Board review workflow hasn't happened
// in-system yet) — requires a comment for the record, and only applies
// to applications genuinely awaiting board review.
// NOTE: this router has no auth middleware attached (consistent with
// every other endpoint in this file), so role enforcement currently
// lives only in the frontend UI. `approved_by` is trusted from the
// request body for the audit trail — worth tightening with real
// server-side auth before this is relied on for compliance purposes.
router.post("/board_approve", async (req, res) => {
  try {
    const { applicationID, comment, approved_by } = req.body || {};

    if (!applicationID || !comment || !comment.trim()) {
      return res.status(400).json({ message: "applicationID and a comment are both required" });
    }

    const application = await Application.findOne({ where: { id: applicationID } });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const raw = application.toJSON();
    const effective = computeEffectiveStatus(raw);

    if (effective.status !== "SPONSOR_APPROVED") {
      return res.status(400).json({
        message: `This application isn't awaiting board review (current status: ${effective.status}).`,
      });
    }

    await application.update({
      status:             "BOARD_APPROVED",
      sponsors:            effective.sponsors, // carries the sponsor-signed correction, if any, atomically
      board_comment:       comment.trim(),
      board_approved_by:   approved_by || "Admin",
      board_approved_at:   new Date(),
    });

    return res.status(200).json({
      message: "Application approved on behalf of the Board",
      application_status: application.status,
    });
  } catch (error) {
    console.error("Failed to record board approval:", error);
    return res.status(500).json({ message: "Failed to approve application" });
  }
});

export default router;
