import { Queue } from "bullmq";
import connection from "../redis/connection.js";

// Fired at each applicant-facing lifecycle milestone on a licence
// application: submission received, sent back for updates, or approved.
// One job = one email to the applicant. `type` in the job payload
// ("RECEIVED" | "SENT_BACK" | "APPROVED") selects which template
// application_status_email_worker.js renders — same pattern as
// sponsor_notification_queue.js.
const applicationStatusEmailQueue = new Queue("applicationStatusEmailQueue", { connection });

export default applicationStatusEmailQueue;
