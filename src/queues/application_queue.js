
import { Queue } from "bullmq";
import connection from "../redis/connection.js";

const applicationQueue = new Queue("applicationQueue", { connection });

export default applicationQueue;