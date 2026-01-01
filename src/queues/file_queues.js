import { Queue } from "bullmq";
import connection from "../redis/connection.js";

const fileQueue = new Queue("fileQueue", { connection });

export default fileQueue;