// Full BullMQ dashboard for ALL erb-helper queues.
// URL:  https://helper.erb.go.ug/api/erb/admin/queues
//
// Setup:
//   yarn add @bull-board/api @bull-board/express express-basic-auth
//   .env →  BULL_BOARD_USER=admin
//           BULL_BOARD_PASS=<strong password>
//
// Not mounted unless BULL_BOARD_PASS is set — never expose it without auth.
import basicAuth from "express-basic-auth";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

import invoiceQueue                from "./queues/invoice_queue.js";
import emailQueue                  from "./queues/email_queues.js";
import receiptQueue                from "./queues/receipt_queue.js";
import paymentReceiptQueue         from "./queues/payment_receipt_queue.js";
import applicationQueue            from "./queues/application_queue.js";
import applicationStatusEmailQueue from "./queues/application_status_email_queue.js";
import sponsorNotificationQueue    from "./queues/sponsor_notification_queue.js";
import reportQueue                 from "./queues/report_queue.js";
import fileQueue                   from "./queues/file_queues.js";
import fileProcessQueue            from "./queues/file_process_queue.js";
import fileMonitorQueue            from "./queues/file_monitor_queue.js";

export const BULL_BOARD_PATH = "/api/erb/admin/queues";

export default function mountBullBoard(app) {
  const pass = process.env.BULL_BOARD_PASS;
  if (!pass) {
    console.warn("[bull-board] BULL_BOARD_PASS not set — dashboard not mounted");
    return false;
  }

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);

  createBullBoard({
    queues: [
      invoiceQueue, emailQueue, receiptQueue, paymentReceiptQueue,
      applicationQueue, applicationStatusEmailQueue, sponsorNotificationQueue,
      reportQueue, fileQueue, fileProcessQueue, fileMonitorQueue,
    ].map((q) => new BullMQAdapter(q)),
    serverAdapter,
    options: { uiConfig: { boardTitle: "ERB Queues" } },
  });

  app.use(
    BULL_BOARD_PATH,
    basicAuth({
      users: { [process.env.BULL_BOARD_USER || "admin"]: pass },
      challenge: true,
    }),
    serverAdapter.getRouter()
  );

  console.log(`✅ Bull Board mounted at ${BULL_BOARD_PATH}`);
  return true;
}
