// ── Application progress (0–100%) ────────────────────────────────────
// One number that says how far an application is from being registered,
// shown as a progress bar on the admin Pending Applications table and on
// the applicant's own application page.
//
//   Drafts  The same form-completion % the applicant sees on their
//           "saved draft" screen (see computeFormCompletion below).
//   40%     Sent back for corrections — the form is complete, but it's back
//           in the applicant's hands until they resubmit.
//   45%     Submitted, awaiting sponsor confirmation
//   50%     Payment review (Accounts)
//   70%     Board review
//   90%     Finalizing (board approved, registration fee / licence pending)
//   100%    Registered
//
// Pure function — no DB access — so it can run on every row of a list.

const parseJsonCol = (val) => {
  if (!val) return []
  if (Array.isArray(val)) return val
  try { const v = JSON.parse(val); return Array.isArray(v) ? v : [] } catch { return [] }
}

const has = (v) => v !== null && v !== undefined && String(v).trim() !== ''

const STAGE_PROGRESS = {
  DEFERRED:                  40,
  PENDING:                   45,
  AWAITING_SPONSOR_APPROVAL: 45,
  SPONSOR_APPROVED:          50,
  ACCOUNTS_APPROVED:         70,
  BOARD_APPROVED:            90,
  REGISTERED:               100,
  COMPLETED:                100,
}

const STAGE_LABEL = {
  DEFERRED:                  'Sent back for corrections',
  PENDING:                   'Submitted',
  AWAITING_SPONSOR_APPROVAL: 'Awaiting sponsors',
  SPONSOR_APPROVED:          'Payment review',
  ACCOUNTS_APPROVED:         'Board review',
  BOARD_APPROVED:            'Finalizing',
  REGISTERED:                'Registered',
  COMPLETED:                 'Registered',
}

// Mirrors the percentage the applicant already sees on the "You have a saved
// draft" screen (DraftResumeScreen in License/Application.jsx), so admins and
// the applicant always read the same number for a draft. Keep the two in
// sync if either changes: completed sections ÷ 6 wizard steps.
const WIZARD_STEP_COUNT = 6

export function computeFormCompletion(raw) {
  const completedSections = [
    has(raw.type),
    has(raw.first_name),
    parseJsonCol(raw.education).length > 0,
    parseJsonCol(raw.sponsors).length > 0,
  ].filter(Boolean).length
  return Math.round((completedSections / WIZARD_STEP_COUNT) * 100)
}

/**
 * @param {object} raw        application row (toJSON())
 * @param {object} opts
 * @param {string} opts.status      effective status (after computeEffectiveStatus)
 * @returns {{ percent: number, stage: string }}
 */
export function computeApplicationProgress(raw, { status } = {}) {
  const s = String(status || raw.status || '').toUpperCase()

  // Sent back → always 40%, regardless of draft_type (which is flipped to
  // "draft" on send-back so the applicant can edit it again).
  if (s === 'DEFERRED') {
    return { percent: STAGE_PROGRESS.DEFERRED, stage: STAGE_LABEL.DEFERRED }
  }

  const isComplete = String(raw.draft_type || '').toUpperCase() === 'COMPLETE'
  if (!isComplete) {
    // Drafts: show the applicant's own form-completion %, not a pipeline
    // stage — for a draft, "how much of the form is filled in" is the
    // only progress there is.
    return { percent: computeFormCompletion(raw), stage: 'Filling in form' }
  }

  if (s === 'FAILED') return { percent: 45, stage: 'Processing failed' }

  return {
    percent: STAGE_PROGRESS[s] ?? 45,
    stage:   STAGE_LABEL[s] || 'Submitted',
  }
}
