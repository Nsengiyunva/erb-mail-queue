import { Worker } from "bullmq";
import connection from "../redis/connection.js";
import fs from "fs";
import path from "path";
import { sequelize } from "../config/database.js";
import ErbUploadFileModel from "../models/ErbUploadFile.js";
import { DataTypes } from "sequelize";

const FILE_DIR = process.env.FILE_DIR || "/var/ugpass/source";

// Initialize model
const ErbUploadFile = ErbUploadFileModel(sequelize, DataTypes);

const worker = new Worker(
  "fileQueue",
  async (job) => {
    const { buffer, originalName, rowId } = job.data;

    const fileName = `${Date.now()}_${originalName}`;
    const filePath = path.join(FILE_DIR, originalName);

    const transaction = await sequelize.transaction();

    try {
      let fileBuffer;

      // ✅ Convert to Buffer if needed
      if (buffer instanceof Buffer) {
        fileBuffer = buffer;
      } else if (buffer instanceof Blob) {
        // If you somehow pass a browser Blob
        fileBuffer = Buffer.from(await buffer.arrayBuffer());
      } else if (buffer instanceof ArrayBuffer) {
        fileBuffer = Buffer.from(buffer);
      } else if (typeof buffer === "object") {
        // Sometimes JSON-like object comes from frontend
        // Convert it to Buffer
        fileBuffer = Buffer.from(JSON.stringify(buffer));
      } else {
        throw new TypeError("Invalid file buffer type");
      }

      // 1️⃣ Write file to disk
      fs.writeFileSync(filePath, fileBuffer);

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

      throw error; // let BullMQ retry
    }
  },
  {
    connection,
    concurrency: 1,
  }
);

worker.on("completed", (job) => {
  console.log(`✅ File saved for rowId ${job.data.rowId}`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ File job failed for rowId ${job?.data?.rowId}`, err);
});

export default worker;
