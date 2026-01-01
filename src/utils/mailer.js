import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

export async function sendEmail({ to, subject, text, attachments }) {
  return transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject,
    text,
    attachments
  });
}

export async function sendStyledMail(to, subject, htmlContent,  attachments = []) {
  const info = await transporter.sendMail({
    from: `"ERB Notifications" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html: htmlContent,
    attachments
  });

  console.log("Mail sent:", info.messageId);
}
