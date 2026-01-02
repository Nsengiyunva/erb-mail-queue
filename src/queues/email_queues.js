
import { Queue } from "bullmq";
import connection from "../redis/connection.js";

const emailQueue = new Queue("emailQueue", { connection });

export default emailQueue;

