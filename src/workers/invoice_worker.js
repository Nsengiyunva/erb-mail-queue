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
    } = job.data;

    const transaction = await sequelize.transaction();

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
              <p>Please find attached your ERB annual fees invoice for FY ${financialYear || ""}.</p>

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
        `RE: ERB ANNUAL FEES INVOICE ${invoiceNo || ""}`.trim(),
        htmlContent,
        attachments
      );

      // 5️⃣ Update invoice status
      await Invoice.update(
        { status: "sent", sent_at: new Date() },
        { where: { id: invoiceId }, transaction }
      );

      await transaction.commit();

      return { invoiceId };
    } catch (error) {
      await transaction.rollback();

      await Invoice.update(
        { status: "failed" },
        { where: { id: invoiceId } }
      );

      throw error; // let BullMQ retry
    }
  },
  {
    connection,
    concurrency: 3,
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
