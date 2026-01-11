import { Worker } from "bullmq";
import connection from "../redis/connection.js";
import fs from "fs/promises";
import path from "path";
import { sequelize } from "../config/database.js";
import ReceiptModel from "../models/Receipt.js";
import { DataTypes } from "sequelize";
import { sendStyledMail } from "../utils/mailer.js";
import receiptQueue from '../queues/receipt_queue.js'

// Init model
const Receipt = ReceiptModel(sequelize, DataTypes);

const worker = new Worker(
  "receiptQueue",
  async (job) => {
    const {
      receiptId,
      email,
      filePath,
      originalName,
    } = job.data;

    const transaction = await sequelize.transaction();

    try {
      // 1️⃣ Ensure file exists
      await fs.access(filePath);

      // 2️⃣ Prepare attachments
      const attachments = [
        {
          filename: originalName,
          path: filePath,
        },
      ];

      // 3️⃣ Email HTML
      const htmlContent = `
        <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f8f2f2; padding: 30px;">
          <div style="max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 8px;">
            <div style="background-color: #b30000; padding: 20px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0;">
                Engineers Registration Board (ERB)
              </h1>
            </div>

            <div style="padding: 25px;">
              <h2>Dear Engineer, 📄</h2>
              <p>Your receipt</p>

              <p>
                Regards,<br/>
                <strong>ERB Support Team</strong>
              </p>
            </div>
          </div>
        </div>
      `;

      job.updateProgress(70);

      // 4️⃣ Send mail
      await sendStyledMail(
        email,
        "RE: YOUR ERB PAYMENT LICENSE",
        htmlContent,
        attachments
      );

      // 5️⃣ Update receipt status
      await Receipt.update(
        { status: "sent" },
        { where: { id: receiptId }, transaction }
      );

      await transaction.commit();

      return { receiptId };
    } catch (error) {
      await transaction.rollback();

      // Mark as failed
      await Receipt.update(
        { status: "failed" },
        { where: { id: receiptId } }
      );

      throw error; // let BullMQ retry
    }
  },
  {
    connection,
    concurrency: 3,
  }
);

// Logs
worker.on("completed", (job) => {
  console.log(`✅ Receipt email sent (ID: ${job.data.receiptId})`);
});

worker.on("failed", (job, err) => {
  console.error(
    `❌ Receipt job failed (ID: ${job?.data?.receiptId})`,
    err.message
  );
});

export default worker;