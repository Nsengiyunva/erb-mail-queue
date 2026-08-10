import { Queue } from "bullmq";
import connection from "../redis/connection.js";

// Fired once per nominated sponsor when an applicant completes final
// submission of a licence application (draft_type === "COMPLETE").
// Each job = one email to one sponsor, so a failure/retry for one
// sponsor never blocks or resends to the others.
const sponsorNotificationQueue = new Queue("sponsorNotificationQueue", { connection });

export default sponsorNotificationQueue;
