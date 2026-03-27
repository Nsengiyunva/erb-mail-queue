import express from "express";
import { sequelize } from "../config/database.js";
import { DataTypes } from "sequelize";
import ApplicationModel from "../models/Application.js";
import applicationQueue from "../queues/application_queue.js";

const router = express.Router();
const Application = ApplicationModel(sequelize, DataTypes);

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
});

export default router;