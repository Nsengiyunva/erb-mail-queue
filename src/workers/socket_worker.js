import { Worker } from "bullmq";
import connection from '../redis/connection.js';
import { io } from './socket.js';  
// import path from 'path';
// import fs from 'fs/promises';
// import * as db from '../models/index.js';


const worker = new Worker(
    'file-processing',
    async job => {

        for( let  i = 1; i <= 5; i++ ) {
            await new Promise( r => setTimeout( r, 1000 ) );

            let progress = i * 20;
            await job.updateProgress( progress );

            io.to( `job: ${job.id}` ).emit( 'job-progress', {
                jobId: job.id,
                progress,
                status: "pending"
            } );

            return {
                success: true
            }
        }

    }, { connection }
);

worker.on( 'completed', (job) => {
    io.to(`job:${job.id}`).emit('job-completed', {
      jobId: job.id,
      status: 'completed',
    });
  } );
  
  worker.on( 'failed', (job, err) => {
    io.to(`job:${job.id}`).emit('job-failed', {
      jobId: job.id,
      error: err.message,
    });
  } );