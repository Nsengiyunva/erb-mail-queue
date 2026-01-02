// queues/file_monitor_queue.js
import { Queue } from 'bullmq';
import connection from '../redis/connection.js';

export default new Queue('fileMonitorQueue', { connection });
