
import { Queue } from "bullmq";
import connection from "../redis/connection.js";

const reportQueue = new Queue("reportQueue", { connection });

export default reportQueue;