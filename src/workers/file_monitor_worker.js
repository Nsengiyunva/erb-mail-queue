// import { Worker } from 'bullmq'
// import connection from "../redis/connection.js";
// import path from 'path';
// import chokidar from 'chokidar';
// import fs from 'fs';

// const activeWatchers = new Map();

// const worker = new Worker(
//     'fileMonitorQueue',
//     async ( job ) => {
//         const { batchId, files, expectedCount, destinationFolder, sourceFolder } = job.data;

//         console.log(`[${batchId}] Starting to monitor ${expectedCount} files`);

//         return new Promise((resolve, reject) => {
//             const processedFiles = [];

//             const fileMap = new Map(files.map(f => [f.filename, f]));

//             fs.mkdir(destinationFolder, { recursive: true }).catch(console.error);

//             const watcher = chokidar.watch(destinationFolder, {
//                 persistent: true,
//                 ignoreInitial: false,
//                 awaitWriteFinish: {
//                   stabilityThreshold: 2000, // Wait 2s after file stops changing
//                   pollInterval: 100
//                 }
//             } );

//             activeWatchers.set(batchId, watcher);

//             const cleanup = () => {
//                 clearTimeout(timeout);
//                 watcher.close();
//                 activeWatchers.delete(batchId);
//             }

//             const timeout = setTimeout(() => {
//                 cleanup();
//                 reject(new Error(`Timeout: Not all files processed within 15 minutes. Processed ${processedFiles.length}/${expectedCount}`));
//             }, 15 * 60 * 1000);

//             watcher.on('add', async (filePath) => {

//                 const filename = path.basename(filePath);

//                 if (fileMap.has(filename)) {
//                     console.log(`[${batchId}] Detected processed file: ${filename}`);

//                     try {
//                         const stats = await fs.stat(filePath);
//                         const fileInfo = fileMap.get(filename);
                        
//                         processedFiles.push({
//                           ...fileInfo,
//                           processedPath: filePath,
//                           processedAt: new Date().toISOString(),
//                           processedSize: stats.size
//                         });
              
//                         // Update job progress
//                         await job.updateProgress((processedFiles.length / expectedCount) * 100);

//                         if (processedFiles.length === expectedCount) {
//                             console.log(`[${batchId}] All ${expectedCount} files processed!`);
                            
//                             // Add job to process the completed batch
//                             await fileMonitorQueue.add('process-completed-batch', {
//                               batchId,
//                               processedFiles,
//                               sourceFolder,
//                               destinationFolder
//                             });
                
//                             cleanup();
//                             resolve({
//                               success: true,
//                               batchId,
//                               processedCount: processedFiles.length,
//                               files: processedFiles
//                             });
//                         }

//                     } catch( e ) {
//                         console.error(`[${batchId}] Error processing file ${filename}:`, e);
//                     }
//                 }
//             } );

//             watcher.on('error', (error) => {
//                 console.error(`[${batchId}] Watcher error:`, error);
//                 cleanup();
//                 reject(error);
//             } );
//         });
//     }, {
//         connection,
//         concurrency: 1
//     }
// );


// worker.on('completed', (job) => {
//     console.log(`Monitor job ${job.id} completed for batch ${job.data.batchId}`);
//   });
  
// worker.on('failed', (job, err) => {
// console.error(`Monitor job ${job.id} failed:`, err.message);
// });

// export default worker


// workers/file_monitor_worker.js
import { Worker } from 'bullmq';
import connection from '../redis/connection.js';
import { ProcessedFile, FileBatch } from '../models/index.js';

new Worker(
  'fileMonitorQueue',
  async job => {
    const { batchId, files } = job.data;

    await FileBatch.upsert({
      batchId,
      totalFiles: files.length,
      processedFiles: files.length,
      status: 'completed',
      completedAt: new Date()
    });

    for (const file of files) {
      await ProcessedFile.create({
        batchId,
        filename: file.filename,
        path: file.path,
        size: file.size,
        status: 'completed'
      });
    }

    return { batchId, success: true };
  },
  { connection, concurrency: 3 }
);
