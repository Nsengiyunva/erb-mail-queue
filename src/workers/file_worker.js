import { Worker } from "bullmq";
import connection from "../redis/connection.js";
import fs from "fs";
import path from "path";
import { sequelize } from "../config/database.js";
import ErbUploadFileModel from "../models/ErbUploadFile.js";
import { DataTypes } from "sequelize";

const FILE_DIR = "/var/ugpass/source";

// Init model (no sync)
const ErbUploadFile = ErbUploadFileModel(sequelize, DataTypes);

const worker = new Worker(
  "fileQueue",
  async (job) => {
    const { buffer, originalName, rowId } = job.data;

    const fileName = `${Date.now()}_${originalName}`;
    const filePath = path.join(FILE_DIR, fileName);

    const transaction = await sequelize.transaction();

    try {
      // 1️⃣ Write file to disk
      fs.writeFileSync(filePath, buffer);

      // 2️⃣ Insert DB record
      await ErbUploadFile.create(
        {
          row_id: rowId,
          file_path: filePath,
          original_name: originalName,
        },
        { transaction }
      );

      await transaction.commit();

      return { filePath };
    } catch (error) {
      await transaction.rollback();

      // Cleanup partially written file
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      throw error; // allow BullMQ retries
    }
  },
  {
    connection,
    concurrency: 1, // sequential file writes
  }
);

worker.on("completed", (job) => {
  console.log(`✅ File saved for rowId ${job.data.rowId}`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ File job failed for rowId ${job?.data?.rowId}`, err);
});

export default worker;
