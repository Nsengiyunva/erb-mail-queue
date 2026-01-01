import { Worker } from "bullmq";
import connection from "../redis/connection.js";
import fs from "fs";
import path from "path";
import { sequelize } from "../database/index.js";
import ErbUploadFileModel from "../models/ErbUploadFile.js";
import { DataTypes } from "sequelize";

const FILE_DIR = "/var/ugpass/source";

// Init model
const ErbUploadFile = ErbUploadFileModel(sequelize, DataTypes);

const worker = new Worker(
  "fileQueue",
  async (job) => {
    const { buffer, originalName, rowId } = job.data;

    const fileName = `${Date.now()}_${originalName}`;
    const filePath = path.join(FILE_DIR, fileName);

    const transaction = await sequelize.transaction();

    try {
      let fileBuffer;

      // ⚠️ If you receive a Blob from React PDF, convert it to Buffer
      if (buffer instanceof Blob) {
        fileBuffer = Buffer.from(await buffer.arrayBuffer());
      } else {
        fileBuffer = buffer; // already a Buffer
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

      // cleanup partially written file
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      throw error; // BullMQ retry
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
