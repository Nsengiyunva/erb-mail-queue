import { Worker }    from "bullmq";
import connection    from "../redis/connection.js";
import fs            from "fs/promises";
import { sequelize } from "../config/database.js";
import { DataTypes }  from "sequelize";
import { sendStyledMail } from "../utils/mailer.js";
import { PaymentTransaction } from "../controllers/receipt-controller.js";
import { Application } from "../models/index.js";

const fmtUGX = (n) =>
  n == null ? "-" : `${Number(n).toLocaleString("en-UG", { maximumFractionDigits: 0 })} UGX`;

const PURPOSE_EMAIL_LABEL = {
  APPLICATION:  "ERB application fee",
  REGISTRATION: "ERB annual registration fee",
  RENEWAL:      "ERB annual renewal fee",
};

const worker = new Worker(
  "paymentReceiptQueue",
  async (job) => {
    const {
      transactionRef,
      email,
      filePath,
      applicantName,
      amount,
      purpose,
      applicationId, // set only for the accounts-verification / no-PaymentTransaction path
    } = job.data;

    try {
      // 1️⃣ Ensure the generated PDF is actually on disk
      await fs.access(filePath);

      const label = PURPOSE_EMAIL_LABEL[purpose] || "ERB application/registration fee";

      // 2️⃣ Email HTML
      const htmlContent = `
        <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f8f2f2; padding: 30px;">
          <div style="max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 8px;">
            <div style="background-color: #b30000; padding: 20px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 20px;">
                Engineers Registration Board (ERB)
              </h1>
            </div>

            <div style="padding: 25px;">
              <h2 style="margin-top: 0;">Dear ${applicantName || "Engineer"}, ✅</h2>
              <p>Your payment of <strong>${fmtUGX(amount)}</strong> for your ${label} was received successfully.</p>
              <p>Your official payment receipt is attached to this email as a PDF — please keep it for your records.</p>

              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr>
                  <td style="padding: 6px 0; color: #555;">Transaction Ref.</td>
                  <td style="padding: 6px 0; font-weight: bold; text-align: right;">${transactionRef || "-"}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #555; border-top: 1px solid #eee;">Amount Paid</td>
                  <td style="padding: 6px 0; font-weight: bold; text-align: right; border-top: 1px solid #eee; color: #15803d;">
                    ${fmtUGX(amount)}
                  </td>
                </tr>
              </table>

              <p>
                Regards,<br/>
                <strong>ERB Accounts Team</strong>
              </p>
            </div>
          </div>
        </div>
      `;

      job.updateProgress(70);

      // 3️⃣ Send mail with the PDF receipt attached
      await sendStyledMail(
        email,
        `RE: ERB PAYMENT RECEIPT — ${transactionRef || ""}`.trim(),
        htmlContent,
        [{ filename: `ERB_Receipt_${transactionRef || "payment"}.pdf`, path: filePath }]
      );

      // 4️⃣ Mark as sent
      if (applicationId) {
        await Application.update(
          { accounts_receipt_email_status: "SENT" },
          { where: { id: applicationId } }
        );
      } else {
        await PaymentTransaction.update(
          { receipt_email_status: "SENT" },
          { where: { transaction_ref: transactionRef } }
        );
      }

      return { transactionRef };
    } catch (error) {
      if (applicationId) {
        await Application.update(
          { accounts_receipt_email_status: "FAILED" },
          { where: { id: applicationId } }
        );
      } else {
        await PaymentTransaction.update(
          { receipt_email_status: "FAILED" },
          { where: { transaction_ref: transactionRef } }
        );
      }
      throw error; // let BullMQ retry
    }
  },
  {
    connection,
    concurrency: 3,
  }
);

worker.on("completed", (job) => {
  console.log(`✅ Payment receipt emailed (ref: ${job.data.transactionRef})`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ Payment receipt job failed (ref: ${job?.data?.transactionRef})`, err.message);
});

export default worker;
