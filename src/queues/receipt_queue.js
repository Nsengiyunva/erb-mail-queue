import { Queue } from "bullmq";
import connection from "../redis/connection.js";

const receiptQueue = new Queue("receiptQueue", { connection });

export default receiptQueue;