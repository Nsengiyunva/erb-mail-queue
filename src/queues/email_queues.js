// import { Queue } from 'bullmq';
// import Redis from 'ioredis';

// const connection = new Redis({
//   host: '127.0.0.1',
//   port: 6379
// } );

// const emailQueue = new Queue('emailQueue', { connection });

// export default emailQueue;

import { Queue } from "bullmq";
import connection from "../redis/connection.js";

const emailQueue = new Queue("emailQueue", { connection });

export default emailQueue;

