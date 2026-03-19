import { Worker } from "bullmq";
import connection from "../redis/connection.js";
import fs from "fs";
import path from "path";
import { sequelize } from "../config/database.js";
import ErbUploadFileModel from "../models/ErbUploadFile.js";
import { DataTypes } from "sequelize";

const FILE_DIR = "/home/user1/ERB/uploads";

// Ensure directory exists
if (!fs.existsSync(FILE_DIR)) {
  fs.mkdirSync(FILE_DIR, { recursive: true });
}

// Initialize model
const ErbUploadFile = ErbUploadFileModel(sequelize, DataTypes);

const worker = new Worker(
  "reportQueue",
  async (job) => {
    const {
      buffer,
      originalName,
      rowId,
      email_address,
      user_id,
      file_type,
      file_size
    } = job.data;

    // 🔒 Safer filename
    const ext = path.extname(originalName);
    const safeName = path
      .basename(originalName, ext)
      .replace(/[^a-zA-Z0-9]/g, "_");

    const fileName = `${Date.now()}_${safeName}${ext}`;
    const filePath = path.join(FILE_DIR, fileName);

    const transaction = await sequelize.transaction();

    try {
      let fileBuffer;

      // ✅ Handle large buffers safely (up to 50MB+)
      if (buffer instanceof Buffer) {
        fileBuffer = buffer;
      } else if (buffer instanceof ArrayBuffer) {
        fileBuffer = Buffer.from(buffer);
      } else if (buffer?.type === "Buffer" && Array.isArray(buffer.data)) {
        // 🔥 Handles serialized buffer from JSON (VERY COMMON in queues)
        fileBuffer = Buffer.from(buffer.data);
      } else {
        throw new TypeError("Invalid file buffer type");
      }

      // 🚫 Optional: enforce 50MB limit (extra safety)
      const MAX_SIZE = 50 * 1024 * 1024;
      if (fileBuffer.length > MAX_SIZE) {
        throw new Error("File exceeds 50MB limit");
      }

      // 1️⃣ Write file to disk
      fs.writeFileSync(filePath, fileBuffer);

      // 2️⃣ Save to DB
      const record = await ErbUploadFile.create(
        {
          row_id: rowId,
          file_path: filePath,
          original_name: originalName,
          file_type: file_type || ext.replace(".", ""),
          email_address,
          user_id,
          file_size: file_size || fileBuffer.length
        },
        { transaction }
      );

      await transaction.commit();

      return {
        success: true,
        id: record.id,
        filePath
      };

    } catch (error) {
      await transaction.rollback();

    
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      throw error;
    }
  },
  {
    connection,
    concurrency: 2, 
  }
);

// ✅ Events
worker.on("completed", (job) => {
  console.log(`✅ Report saved for rowId ${job.data.rowId}`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ Report job failed for rowId ${job?.data?.rowId}`, err.message);
});

worker.on("active", (job) => {
  console.log(`🚀 Processing job ${job.id}`);
});

export default worker;