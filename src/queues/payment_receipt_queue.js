import { Queue } from "bullmq";
import connection from "../redis/connection.js";

// Consumed by workers/payment_receipt_worker.js — queue name must match
// exactly ("paymentReceiptQueue"), that's how BullMQ pairs a Queue with
// its Worker.
const paymentReceiptQueue = new Queue("paymentReceiptQueue", { connection });

export default paymentReceiptQueue;
