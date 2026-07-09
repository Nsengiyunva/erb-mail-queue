import { Queue } from "bullmq";
import connection from "../redis/connection.js";

const invoiceQueue = new Queue("invoiceQueue", { connection });

export default invoiceQueue;
