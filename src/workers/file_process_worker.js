// import { Worker  } from  'bullmq'
// const fs = require('fs').promises;
// import path from 'path'
// import { sequelize } from "../config/database.js";

// const pool = mysql.createPool({
//     host: 'localhost',
//     user: 'your_user',
//     password: 'your_password',
//     database: 'your_database',
//     waitForConnections: true,
//     connectionLimit: 10
//   });

// const worker = new Worker('fileProcessQueue', async (job) => {
//   const { batchId, processedFiles, sourceFolder, destinationFolder } = job.data;
  
//   console.log(`[${batchId}] Processing ${processedFiles.length} completed files`);

//   const finalFolder = path.join(__dirname, '../uploads/final');

//   await fs.mkdir(finalFolder, { recursive: true });

//   const dbConnection = await pool.getConnection();
  
//   try {
//     await dbConnection.beginTransaction();

//     for (const file of processedFiles) {
//       // Move file to final location
//       const finalPath = path.join(finalFolder, file.filename);
//       await fs.rename(file.processedPath, finalPath);
      
//       console.log(`[${batchId}] Moved ${file.filename} to final folder`);

//       // Update database
//       const [result] = await dbConnection.execute(
//         `INSERT INTO processed_files 
//          (batch_id, original_name, filename, file_path, file_size, processed_at, status) 
//          VALUES (?, ?, ?, ?, ?, ?, ?)`,
//         [
//           batchId,
//           file.originalName,
//           file.filename,
//           finalPath,
//           file.processedSize,
//           file.processedAt,
//           'completed'
//         ]
//       );

//       console.log(`[${batchId}] Database updated for ${file.filename}, ID: ${result.insertId}`);
//     }

//     // Update batch status
//     await dbConnection.execute(
//       `INSERT INTO file_batches (batch_id, total_files, processed_files, status, completed_at)
//        VALUES (?, ?, ?, ?, ?)
//        ON DUPLICATE KEY UPDATE 
//        processed_files = VALUES(processed_files),
//        status = VALUES(status),
//        completed_at = VALUES(completed_at)`,
//       [batchId, processedFiles.length, processedFiles.length, 'completed', new Date()]
//     );

//     await dbConnection.commit();

//     // Clean up source files
//     for (const file of processedFiles) {
//       const sourcePath = path.join(sourceFolder, file.filename);
//       try {
//         await fs.unlink(sourcePath);
//         console.log(`[${batchId}] Cleaned up source file: ${file.filename}`);
//       } catch (err) {
//         console.warn(`[${batchId}] Could not delete source file ${file.filename}:`, err.message);
//       }
//     }

//     return {
//       success: true,
//       batchId,
//       processedCount: processedFiles.length,
//       message: 'All files processed and database updated'
//     };

//   } catch (error) {
//     await dbConnection.rollback();
//     throw error;
//   } finally {
//     dbConnection.release();
//   }
// }, {
//   connection,
//   concurrency: 3
// });

// worker.on('completed', (job) => {
//   console.log(`Process job ${job.id} completed for batch ${job.data.batchId}`);
// });

// worker.on('failed', (job, err) => {
//   console.error(`Process job ${job.id} failed:`, err.message);
// });


// export default worker;


// workers/file_process_worker.js
import { Worker } from 'bullmq';
import fs from 'fs/promises';
import path from 'path';
import connection from '../redis/connection.js';
import fileMonitorQueue from '../queues/file_monitor_queue.js';

const SOURCE_DIR = '/var/ugpass/source';
const DEST_DIR   = '/home/user1/ERB/registrad';

new Worker(
  'fileProcessQueue',
  async job => {
    const { batchId, files } = job.data;
    const movedFiles = [];

    for (const file of files) {
      const src = path.join(SOURCE_DIR, file.filename);
      const dest = path.join(DEST_DIR, file.filename);

      await fs.rename(src, dest);
      const stats = await fs.stat(dest);

      movedFiles.push({
        ...file,
        path: dest,
        size: stats.size
      });
    }

    await fileMonitorQueue.add('batch-ready', {
      batchId,
      files: movedFiles
    });

    return { batchId, count: movedFiles.length };
  },
  { connection, concurrency: 2 }
);
