// Panel-review module — staff e-mails (queued through the existing
// applicationStatusEmailQueue; templates live in
// workers/application_status_email_worker.js).
//
//   PANEL_ASSIGNED        → the panel member, listing the applications allocated to them
//   EVALUATION_SUBMITTED  → Registrar / Registration Officer: a member submitted an evaluation (the application is now in Board review)
//   APPLICANT_RESUBMITTED → Registrar / Registration Officer: an applicant resubmitted after a send-back
//
// Panel members' comments are NEVER e-mailed to applicants — applicants are
// only ever e-mailed by the Registrar / Registration Officer's own send-back.
import applicationStatusEmailQueue from "../queues/application_status_email_queue.js";

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: true,
  removeOnFail: false,
};

// Who receives the "evaluation submitted" and "applicant resubmitted" alerts:
// the Registrar / Registration Officer mailbox(es). Comma-separated list in
// ERB_REVIEW_NOTIFY_EMAILS; falls back to the system mailbox so nothing is
// silently dropped if it isn't configured yet.
export function reviewTeamRecipients() {
  const raw = process.env.ERB_REVIEW_NOTIFY_EMAILS || process.env.SMTP_USER || "";
  return [...new Set(String(raw).split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean))];
}

// Resolves to the queued job (or null if the queue could not take it).
const queueOne = (name, data) =>
  applicationStatusEmailQueue
    .add(name, data, JOB_OPTS)
    .catch((err) => { console.error(`[panel-notify] could not queue ${data.type} email to ${data.to}:`, err.message); return null; });

export async function notifyMemberAssigned({ member, panel, applications }) {
  if (!member?.email || !applications?.length) return null;
  const job = await queueOne("panel-assigned-email", {
    type:         "PANEL_ASSIGNED",
    to:           member.email,
    memberName:   member.name,
    panelName:    panel?.name,
    applications, // [{ trackingNumber, applicantName, applicationType, category }]
  });
  return job?.id != null ? String(job.id) : null;
}

export async function notifyEvaluationSubmitted({ trackingNumber, applicantName, applicationType, applicationId, evaluatorName, panelName, summary, movedToBoard = false }) {
  for (const to of reviewTeamRecipients()) {
    await queueOne("panel-evaluation-submitted-email", {
      type: "EVALUATION_SUBMITTED",
      to, trackingNumber, applicantName, applicationType, applicationId, evaluatorName, panelName, summary, movedToBoard,
    });
  }
}

export async function notifyApplicantResubmitted({ trackingNumber, applicantName, applicationType, applicationId }) {
  for (const to of reviewTeamRecipients()) {
    await queueOne("applicant-resubmitted-email", {
      type: "APPLICANT_RESUBMITTED",
      to, trackingNumber, applicantName, applicationType, applicationId,
    });
  }
}
