import { Worker } from "bullmq";
import connection from "../redis/connection.js";
import fs from "fs/promises";
import { sequelize } from "../config/database.js";
import { DataTypes } from "sequelize";
import InvoiceModel from "../models/Invoice.js";
import { sendStyledMail } from "../utils/mailer.js";

const Invoice = InvoiceModel(sequelize, DataTypes);

const fmtUGX = (n) =>
  `${Number(n || 0).toLocaleString("en-UG", { maximumFractionDigits: 0 })} UGX`;

const worker = new Worker(
  "invoiceQueue",
  async (job) => {
    const {
      invoiceId,
      email,
      filePath,
      originalName,
      invoiceNo,
      engineerName,
      financialYear,
      totalAmount,
      invoiceType,
    } = job.data;

    // Same queue/worker for both invoice kinds — only the wording differs.
    // For TEMPORARY, financialYear carries the renewal year (e.g. "2027").
    const isTemporary = String(invoiceType || "").toUpperCase() === "TEMPORARY";
    const introLine = isTemporary
      ? `Please find attached your ERB temporary engineer's registration, licence and stamp renewal invoice for ${financialYear || ""}.`
      : `Please find attached your ERB annual fees invoice for FY ${financialYear || ""}.`;
    const subject = isTemporary
      ? `RE: ERB TEMPORARY ENGINEER'S INVOICE — REGISTRATION, LICENCE AND STAMP RENEWAL ${financialYear || ""} ${invoiceNo || ""}`
      : `RE: ERB ANNUAL FEES INVOICE ${invoiceNo || ""}`;

    // No DB transaction here: the only write is a single-row UPDATE, and
    // holding a transaction open across the SMTP call tied up a pool
    // connection and could trigger a double email if commit failed.
    try {
      // 1️⃣ Ensure file exists
      await fs.access(filePath);

      // 2️⃣ Prepare attachment
      const attachments = [
        {
          filename: originalName,
          path: filePath,
        },
      ];

      // 3️⃣ Email HTML
      const htmlContent = `
        <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f8f2f2; padding: 30px;">
          <div style="max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 8px;">
            <div style="background-color: #b30000; padding: 20px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 20px;">
                Engineers Registration Board (ERB)
              </h1>
            </div>

            <div style="padding: 25px;">
              <h2 style="margin-top: 0;">Dear ${engineerName || "Engineer"}, 📄</h2>
              <p>${introLine}</p>

              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr>
                  <td style="padding: 6px 0; color: #555;">Invoice No.</td>
                  <td style="padding: 6px 0; font-weight: bold; text-align: right;">${invoiceNo || "-"}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #555; border-top: 1px solid #eee;">Amount Due</td>
                  <td style="padding: 6px 0; font-weight: bold; text-align: right; border-top: 1px solid #eee; color: #b30000;">
                    ${fmtUGX(totalAmount)}
                  </td>
                </tr>
              </table>

              <p>Kindly arrange payment as detailed in the attached invoice.</p>

              <p>
                Regards,<br/>
                <strong>ERB Accounts Team</strong>
              </p>
            </div>
          </div>
        </div>
      `;

      job.updateProgress(70);

      // 4️⃣ Send mail
      await sendStyledMail(
        email,
        subject.replace(/\s+/g, " ").trim(),
        htmlContent,
        attachments
      );

      // 5️⃣ Update invoice status
      await Invoice.update(
        { status: "sent", sent_at: new Date(), send_error: null },
        { where: { id: invoiceId } }
      );

      return { invoiceId };
    } catch (error) {
      // Only mark 'failed' once BullMQ has no retries left — otherwise the
      // record would flip failed → sent and pollers would stop too early.
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts?.attempts || 1);
      await Invoice.update(
        {
          status: isLastAttempt ? "failed" : "pending",
          send_error: String(error?.message || error).slice(0, 1000),
        },
        { where: { id: invoiceId } }
      );

      throw error; // let BullMQ retry
    }
  },
  {
    connection,
    concurrency: 3,
    // Bulk uploads can queue hundreds of emails at once — throttle so the
    // SMTP provider doesn't start rejecting us. Tune with INVOICE_MAILS_PER_MINUTE.
    limiter: {
      max: Number(process.env.INVOICE_MAILS_PER_MINUTE) || 60,
      duration: 60_000,
    },
  }
);

worker.on("completed", (job) => {
  console.log(`✅ Invoice email sent (ID: ${job.data.invoiceId})`);
});

worker.on("failed", (job, err) => {
  console.error(
    `❌ Invoice job failed (ID: ${job?.data?.invoiceId})`,
    err.message
  );
});

export default worker;
