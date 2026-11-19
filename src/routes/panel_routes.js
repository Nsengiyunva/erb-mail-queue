// Panel-review module — API (mounted at /api/erb/panel).
//
// Pipeline position:  Payment review → AWAITING_ALLOCATION → PANEL_REVIEW → Board review
// (Board review is still ACCOUNTS_APPROVED, so nothing after it changes.)
//
// Soft-auth, same convention as the rest of erb-helper:
//   x-user-role   admin `level` (REGISTRAR | REGISTRATION | CHAIRMAN | PANEL …)
//   x-user-email  e-mail of the signed-in user — identifies a PANEL member
//
// • Registrar / Registration Officer: allocate, re-assign, forward to Board,
//   see every comment as it is added, dashboard summary.
// • Panel member: only their own assignments; comments are INTERNAL.
// • Panel chairperson: read-only view of every member's work + comments in
//   their panel, and can be assigned applications like any other member.
// Only the Registrar / Registration Officer can defer to the applicant (the
// existing POST /application/defer); panel comments never e-mail applicants.
import express from "express";
import { Op } from "sequelize";
import { sequelize } from "../config/database.js";
import ApplicationModel from "../models/Application.js";
import ApplicationCommentModel from "../models/ApplicationComment.js";
import { DataTypes } from "sequelize";
import { formatApplicantName } from "../utils/applicant-name.js";
import { sanitizeRichText, isRichText, richTextToPlain } from "../utils/rich-text.js";
import { Panel, PanelMember, PanelAssignment, syncPanelTables, supersedeActiveAssignments, PANEL_STATUS } from "../utils/panel-models.js";
import { notifyMemberAssigned, notifyEvaluationSubmitted } from "../utils/panel-notify.js";

const router = express.Router();
const Application = ApplicationModel(sequelize, DataTypes);
const ApplicationComment = sequelize.models.ApplicationComment || ApplicationCommentModel(sequelize, DataTypes);

syncPanelTables();

const STAFF_ROLES = ["REGISTRAR", "REGISTRATION"];          // act on the pipeline
const VIEW_ROLES  = [...STAFF_ROLES, "CHAIRMAN"];            // read the dashboard / panels
const PANEL_EVENTS = ["PANEL_COMMENT", "PANEL_EVALUATION", "PANEL_ASSIGNED", "PANEL_FORWARDED"];
const tracking = (id) => `ERB-${String(id).padStart(5, "0")}`;
const roleOf = (req) => String(req.headers["x-user-role"] || "").toUpperCase();
const emailOf = (req) => String(req.headers["x-user-email"] || "").trim().toLowerCase();
const fail = (res, status, message) => res.status(status).json({ message });

const requireStaff = (req, res, next) =>
  STAFF_ROLES.includes(roleOf(req)) ? next() : fail(res, 403, "Only the Registrar or Registration Officer can do this");
const requireViewer = (req, res, next) =>
  VIEW_ROLES.includes(roleOf(req)) ? next() : fail(res, 403, "You don't have access to this");

// Resolves the signed-in PANEL user to their member record.
async function resolveMember(req, res, next) {
  try {
    if (roleOf(req) !== "PANEL") return fail(res, 403, "Panel members only");
    const email = emailOf(req);
    if (!email) return fail(res, 403, "Your e-mail is missing from the request");
    const member = await PanelMember.findOne({ where: { email, is_active: true }, include: [{ model: Panel, as: "panel" }] });
    if (!member) return fail(res, 403, "You have not been added to a panel yet. Please contact the Registrar.");
    req.member = member;
    next();
  } catch (err) {
    console.error("[panel] resolveMember failed:", err);
    fail(res, 500, "Could not verify your panel membership");
  }
}

const appSummary = (a) => {
  const raw = a.toJSON ? a.toJSON() : a;
  return {
    id: raw.id,
    tracking_number: tracking(raw.id),
    applicant_name: formatApplicantName(raw),
    email_address: raw.email_address,
    type: raw.type,
    category: raw.category,
    profession: raw.profession,
    status: raw.status,
    submitted_at: raw.updated_at,
  };
};

const memberJson = (m) => ({ id: m.id, panel_id: m.panel_id, name: m.name, email: m.email, is_chair: !!m.is_chair, is_active: !!m.is_active });

// Workload per member: open (ASSIGNED) and completed (SUBMITTED / FORWARDED).
async function workloadByMember(memberIds) {
  const out = {};
  if (!memberIds.length) return out;
  const rows = await PanelAssignment.findAll({
    attributes: ["member_id", "status", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
    where: { member_id: { [Op.in]: memberIds }, status: { [Op.in]: ["ASSIGNED", "SUBMITTED", "FORWARDED"] } },
    group: ["member_id", "status"],
    raw: true,
  });
  for (const r of rows) {
    const w = (out[r.member_id] ||= { open: 0, completed: 0, awaiting_registrar: 0 });
    const n = parseInt(r.n, 10) || 0;
    if (r.status === "ASSIGNED") w.open += n;
    else { w.completed += n; if (r.status === "SUBMITTED") w.awaiting_registrar += n; }
  }
  return out;
}

const cleanMessage = (raw) => {
  const text = String(raw || "").trim();
  const clean = isRichText(text) ? sanitizeRichText(text) : text;
  return { text: clean, visible: richTextToPlain(clean) };
};

// ───────────────────────── Panels & members (staff) ─────────────────────────

router.get("/panels", requireViewer, async (_req, res) => {
  try {
    await syncPanelTables();
    const panels = await Panel.findAll({ include: [{ model: PanelMember, as: "members" }], order: [["name", "ASC"], [{ model: PanelMember, as: "members" }, "name", "ASC"]] });
    const ids = panels.flatMap((p) => p.members.map((m) => m.id));
    const load = await workloadByMember(ids);
    res.json({
      panels: panels.map((p) => ({
        id: p.id, name: p.name, description: p.description, is_active: !!p.is_active,
        members: p.members.map((m) => ({ ...memberJson(m), ...(load[m.id] || { open: 0, completed: 0, awaiting_registrar: 0 }) })),
      })),
    });
  } catch (err) {
    console.error("[panel] list panels:", err);
    fail(res, 500, "Could not load panels");
  }
});

router.post("/panels", requireStaff, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return fail(res, 400, "Panel name is required");
  try {
    await syncPanelTables();
    const panel = await Panel.create({ name, description: req.body?.description || null });
    res.status(201).json({ panel: { id: panel.id, name: panel.name, members: [] } });
  } catch (err) {
    console.error("[panel] create panel:", err);
    fail(res, 500, "Could not create the panel");
  }
});

router.put("/panels/:id", requireStaff, async (req, res) => {
  try {
    const panel = await Panel.findByPk(req.params.id);
    if (!panel) return fail(res, 404, "Panel not found");
    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim() || panel.name;
    if (req.body?.description !== undefined) patch.description = req.body.description;
    if (req.body?.is_active !== undefined) patch.is_active = !!req.body.is_active;
    await panel.update(patch);
    res.json({ panel });
  } catch (err) {
    console.error("[panel] update panel:", err);
    fail(res, 500, "Could not update the panel");
  }
});

async function makeOnlyChair(panelId, memberId) {
  await PanelMember.update({ is_chair: false }, { where: { panel_id: panelId, id: { [Op.ne]: memberId } } });
}

router.post("/panels/:id/members", requireStaff, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return fail(res, 400, "A name and a valid e-mail are required");
  try {
    const panel = await Panel.findByPk(req.params.id);
    if (!panel) return fail(res, 404, "Panel not found");
    // A person sits on one panel at a time.
    const existing = await PanelMember.findOne({ where: { email, is_active: true } });
    if (existing) return fail(res, 409, `${email} is already a member of another panel`);
    const member = await PanelMember.create({ panel_id: panel.id, name, email, is_chair: !!req.body?.is_chair });
    if (member.is_chair) await makeOnlyChair(panel.id, member.id);
    res.status(201).json({ member: memberJson(member) });
  } catch (err) {
    console.error("[panel] add member:", err);
    fail(res, 500, "Could not add the member");
  }
});

router.put("/members/:id", requireStaff, async (req, res) => {
  try {
    const member = await PanelMember.findByPk(req.params.id);
    if (!member) return fail(res, 404, "Member not found");
    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim() || member.name;
    if (req.body?.email !== undefined) patch.email = String(req.body.email).trim().toLowerCase();
    if (req.body?.is_chair !== undefined) patch.is_chair = !!req.body.is_chair;
    if (req.body?.is_active !== undefined) {
      patch.is_active = !!req.body.is_active;
      if (!patch.is_active) {
        const open = await PanelAssignment.count({ where: { member_id: member.id, status: "ASSIGNED" } });
        if (open) return fail(res, 409, `${member.name} still has ${open} open application(s). Re-assign them first.`);
      }
    }
    await member.update(patch);
    if (member.is_chair) await makeOnlyChair(member.panel_id, member.id);
    res.json({ member: memberJson(member) });
  } catch (err) {
    console.error("[panel] update member:", err);
    fail(res, 500, "Could not update the member");
  }
});

// ───────────────────────── Allocation (staff) ─────────────────────────

// Applications whose payment Accounts has verified and that are waiting for a panel.
router.get("/queue", requireStaff, async (_req, res) => {
  try {
    const rows = await Application.findAll({
      where: { draft_type: "COMPLETE", status: PANEL_STATUS.AWAITING_ALLOCATION },
      order: [["updated_at", "ASC"]],
    });
    const ids = rows.map((r) => r.id);
    const prior = ids.length
      ? await PanelAssignment.findAll({ where: { application_id: { [Op.in]: ids } }, attributes: ["application_id", "round"], raw: true })
      : [];
    const rounds = {};
    for (const p of prior) rounds[p.application_id] = Math.max(rounds[p.application_id] || 0, p.round);
    res.json({ applications: rows.map((r) => ({ ...appSummary(r), previous_rounds: rounds[r.id] || 0 })) });
  } catch (err) {
    console.error("[panel] queue:", err);
    fail(res, 500, "Could not load the allocation queue");
  }
});

// Assign (or re-assign) one or more applications to a panel member.
router.post("/assign", requireStaff, async (req, res) => {
  const { applicationIDs, member_id, assigned_by } = req.body || {};
  if (!Array.isArray(applicationIDs) || !applicationIDs.length) return fail(res, 400, "Select at least one application");
  if (applicationIDs.length > 100) return fail(res, 400, "Please assign 100 applications or fewer at a time");
  try {
    const member = await PanelMember.findOne({ where: { id: member_id, is_active: true }, include: [{ model: Panel, as: "panel" }] });
    if (!member) return fail(res, 404, "Choose a panel member");
    if (!member.panel?.is_active) return fail(res, 400, "That panel is no longer active");

    const assigned = [];
    const results = [];
    for (const applicationID of applicationIDs) {
      try {
        const application = await Application.findByPk(applicationID);
        if (!application) throw new Error("Application not found");
        const status = String(application.status || "").toUpperCase();
        if (![PANEL_STATUS.AWAITING_ALLOCATION, PANEL_STATUS.PANEL_REVIEW].includes(status)) {
          throw new Error(`Not awaiting allocation (current status: ${status})`);
        }
        const last = await PanelAssignment.max("round", { where: { application_id: application.id } });
        const live = await PanelAssignment.findOne({ where: { application_id: application.id, status: "ASSIGNED" } });
        const submittedBefore = await PanelAssignment.findOne({ where: { application_id: application.id, status: "SUBMITTED" } });
        await supersedeActiveAssignments(application.id);
        // Re-assigning inside the same round keeps the round number; a fresh
        // allocation after a send-back starts the next one.
        const round = status === PANEL_STATUS.PANEL_REVIEW && (live || submittedBefore) ? (last || 1) : (last || 0) + 1;
        await PanelAssignment.create({
          application_id: application.id, panel_id: member.panel_id, member_id: member.id,
          assigned_by: assigned_by || "Admin", assigned_by_role: roleOf(req), status: "ASSIGNED", round,
        });
        await application.update({ status: PANEL_STATUS.PANEL_REVIEW });
        await ApplicationComment.create({
          application_id: application.id, event: "PANEL_ASSIGNED", visibility: "INTERNAL",
          author_type: "ADMIN", author_name: assigned_by || "Admin", author_role: roleOf(req),
          message: `Allocated to ${member.panel?.name || "a panel"} — ${member.name}${member.is_chair ? " (Chairperson)" : ""}.`,
        }).catch((e) => console.error("[panel] could not log assignment:", e.message));
        const raw = application.toJSON();
        assigned.push({ trackingNumber: tracking(raw.id), applicantName: formatApplicantName(raw), applicationType: raw.type, category: raw.category });
        results.push({ applicationID, ok: true });
      } catch (err) {
        results.push({ applicationID, ok: false, message: err.message || "Failed to assign" });
      }
    }
    // One e-mail per member, listing everything allocated to them in this action.
    await notifyMemberAssigned({ member, panel: member.panel, applications: assigned });
    const ok = results.filter((r) => r.ok).length;
    res.json({ message: `${ok} of ${results.length} application(s) assigned to ${member.name}${ok ? " — they have been e-mailed" : ""}`, results });
  } catch (err) {
    console.error("[panel] assign:", err);
    fail(res, 500, "Could not assign the applications");
  }
});

// Registrar / Registration Officer forwards an evaluated application to Board review.
router.post("/application/:id/forward", requireStaff, async (req, res) => {
  const { comment, forwarded_by, force } = req.body || {};
  try {
    const application = await Application.findByPk(req.params.id);
    if (!application) return fail(res, 404, "Application not found");
    const status = String(application.status || "").toUpperCase();
    if (![PANEL_STATUS.PANEL_REVIEW, PANEL_STATUS.AWAITING_ALLOCATION].includes(status)) {
      return fail(res, 400, `This application isn't in panel review (current status: ${status}).`);
    }
    const live = await PanelAssignment.findOne({ where: { application_id: application.id, status: ["ASSIGNED", "SUBMITTED"] }, order: [["id", "DESC"]] });
    if (!force && (!live || live.status !== "SUBMITTED")) {
      return fail(res, 409, "The panel member has not submitted their evaluation yet.");
    }
    if (live) await live.update({ status: "FORWARDED" });
    await application.update({ status: PANEL_STATUS.BOARD_REVIEW });
    await ApplicationComment.create({
      application_id: application.id, event: "PANEL_FORWARDED", visibility: "INTERNAL",
      author_type: "ADMIN", author_name: forwarded_by || "Admin", author_role: roleOf(req),
      message: (comment && String(comment).trim()) || "Panel review complete — forwarded to Board review.",
    }).catch((e) => console.error("[panel] could not log forward:", e.message));
    res.json({ message: "Application forwarded to Board review", application_status: PANEL_STATUS.BOARD_REVIEW });
  } catch (err) {
    console.error("[panel] forward:", err);
    fail(res, 500, "Could not forward the application");
  }
});

// Everything the Registrar needs on one application's panel stage: current
// assignment, history, and every panel comment — newest last.
router.get("/application/:id/panel", requireViewer, async (req, res) => {
  try {
    const application = await Application.findByPk(req.params.id);
    if (!application) return fail(res, 404, "Application not found");
    const assignments = await PanelAssignment.findAll({
      where: { application_id: application.id },
      include: [{ model: PanelMember, as: "member" }, { model: Panel, as: "panel" }],
      order: [["id", "ASC"]],
    });
    const comments = await ApplicationComment.findAll({
      where: { application_id: application.id, event: { [Op.in]: PANEL_EVENTS } },
      order: [["created_at", "ASC"], ["id", "ASC"]],
      raw: true,
    });
    const current = [...assignments].reverse().find((a) => ["ASSIGNED", "SUBMITTED"].includes(a.status)) || null;
    res.json({
      status: application.status,
      current: current && {
        id: current.id, status: current.status, round: current.round, submitted_at: current.submitted_at,
        panel: current.panel?.name, member: current.member && memberJson(current.member),
      },
      history: assignments.map((a) => ({ id: a.id, round: a.round, status: a.status, panel: a.panel?.name, member: a.member?.name, created_at: a.created_at })),
      comments,
    });
  } catch (err) {
    console.error("[panel] application panel view:", err);
    fail(res, 500, "Could not load the panel activity");
  }
});

// ───────────────────────── Panel member / chairperson ─────────────────────────

router.get("/me", resolveMember, async (req, res) => {
  const m = req.member;
  res.json({ member: memberJson(m), panel: { id: m.panel?.id, name: m.panel?.name }, is_chair: !!m.is_chair });
});

const assignmentRow = async (a, withMember = false) => {
  const application = await Application.findByPk(a.application_id);
  const commentCount = await ApplicationComment.count({ where: { application_id: a.application_id, event: "PANEL_COMMENT", author_id: String(a.member_id) } });
  return {
    assignment_id: a.id, status: a.status, round: a.round, assigned_at: a.created_at, submitted_at: a.submitted_at,
    comment_count: commentCount,
    ...(application ? appSummary(application) : { id: a.application_id, tracking_number: tracking(a.application_id) }),
    ...(withMember ? { member_id: a.member_id } : {}),
  };
};

// My assigned applications.
router.get("/my", resolveMember, async (req, res) => {
  try {
    const rows = await PanelAssignment.findAll({
      where: { member_id: req.member.id, status: { [Op.in]: ["ASSIGNED", "SUBMITTED", "FORWARDED"] } },
      order: [["id", "DESC"]],
    });
    res.json({ assignments: await Promise.all(rows.map((a) => assignmentRow(a))) });
  } catch (err) {
    console.error("[panel] my:", err);
    fail(res, 500, "Could not load your applications");
  }
});

// Chairperson: every member of the panel, what they are working on, and the comments.
router.get("/overview", resolveMember, async (req, res) => {
  if (!req.member.is_chair) return fail(res, 403, "Only the panel chairperson can see the panel overview");
  try {
    const members = await PanelMember.findAll({ where: { panel_id: req.member.panel_id, is_active: true }, order: [["name", "ASC"]] });
    const load = await workloadByMember(members.map((m) => m.id));
    const rows = await PanelAssignment.findAll({
      where: { panel_id: req.member.panel_id, status: { [Op.in]: ["ASSIGNED", "SUBMITTED", "FORWARDED"] } },
      order: [["id", "DESC"]],
    });
    const items = [];
    for (const a of rows) {
      const row = await assignmentRow(a, true);
      const last = await ApplicationComment.findOne({
        where: { application_id: a.application_id, event: { [Op.in]: ["PANEL_COMMENT", "PANEL_EVALUATION"] } },
        order: [["id", "DESC"]], raw: true,
      });
      items.push({ ...row, member_name: members.find((m) => m.id === a.member_id)?.name, latest_comment: last ? { author_name: last.author_name, message: last.message, created_at: last.created_at } : null });
    }
    res.json({
      panel: { id: req.member.panel?.id, name: req.member.panel?.name },
      members: members.map((m) => ({ ...memberJson(m), ...(load[m.id] || { open: 0, completed: 0, awaiting_registrar: 0 }) })),
      assignments: items,
    });
  } catch (err) {
    console.error("[panel] overview:", err);
    fail(res, 500, "Could not load the panel overview");
  }
});

// Can this member open this application? Own assignment — or, for the
// chairperson, any assignment in their panel (read-only unless it is theirs).
async function memberAccess(member, applicationId) {
  const mine = await PanelAssignment.findOne({
    where: { application_id: applicationId, member_id: member.id, status: { [Op.in]: ["ASSIGNED", "SUBMITTED", "FORWARDED"] } },
    order: [["id", "DESC"]],
  });
  if (mine) return { assignment: mine, canAct: mine.status === "ASSIGNED" };
  if (member.is_chair) {
    const inPanel = await PanelAssignment.findOne({
      where: { application_id: applicationId, panel_id: member.panel_id, status: { [Op.in]: ["ASSIGNED", "SUBMITTED", "FORWARDED"] } },
      order: [["id", "DESC"]],
    });
    if (inPanel) return { assignment: inPanel, canAct: false };
  }
  return null;
}

router.get("/application/:id/review", resolveMember, async (req, res) => {
  try {
    const access = await memberAccess(req.member, req.params.id);
    if (!access) return fail(res, 403, "This application is not assigned to you");
    const application = await Application.findByPk(req.params.id);
    if (!application) return fail(res, 404, "Application not found");
    const comments = await ApplicationComment.findAll({
      where: {
        application_id: application.id,
        event: { [Op.in]: ["PANEL_COMMENT", "PANEL_EVALUATION"] },
        // A plain member sees only their own comments; the chairperson sees the panel's.
        ...(req.member.is_chair ? {} : { author_id: String(req.member.id) }),
      },
      order: [["created_at", "ASC"], ["id", "ASC"]],
      raw: true,
    });
    res.json({
      assignment: { id: access.assignment.id, status: access.assignment.status, round: access.assignment.round, member_id: access.assignment.member_id },
      can_act: access.canAct,
      application: appSummary(application),
      comments,
    });
  } catch (err) {
    console.error("[panel] review:", err);
    fail(res, 500, "Could not load this application");
  }
});

router.post("/application/:id/comments", resolveMember, async (req, res) => {
  try {
    const access = await memberAccess(req.member, req.params.id);
    if (!access || !access.canAct) return fail(res, 403, "You can only comment on your own open assignments");
    const { text, visible } = cleanMessage(req.body?.message);
    if (!visible) return fail(res, 400, "Please type a comment first");
    if (visible.length > 5000) return fail(res, 400, "Comments are limited to 5,000 characters");
    const comment = await ApplicationComment.create({
      application_id: req.params.id, event: "PANEL_COMMENT",
      // INTERNAL: never visible to the applicant and never e-mailed to them.
      visibility: "INTERNAL", author_type: "ADMIN", author_role: "PANEL",
      author_name: req.member.name, author_id: String(req.member.id), message: text,
    });
    res.status(201).json({ comment: comment.toJSON() });
  } catch (err) {
    console.error("[panel] comment:", err);
    fail(res, 500, "Could not add the comment");
  }
});

// Member sends their evaluation to the Registrar / Registration Officer.
router.post("/application/:id/submit", resolveMember, async (req, res) => {
  try {
    const access = await memberAccess(req.member, req.params.id);
    if (!access || !access.canAct) return fail(res, 403, "You can only submit your own open assignments");
    const { text, visible } = cleanMessage(req.body?.message);
    if (!visible) return fail(res, 400, "Add a short evaluation summary for the Registrar before submitting");
    const application = await Application.findByPk(req.params.id);
    await access.assignment.update({ status: "SUBMITTED", submitted_at: new Date() });
    await ApplicationComment.create({
      application_id: req.params.id, event: "PANEL_EVALUATION", visibility: "INTERNAL",
      author_type: "ADMIN", author_role: "PANEL", author_name: req.member.name, author_id: String(req.member.id), message: text,
    });
    const raw = application.toJSON();
    await notifyEvaluationSubmitted({
      trackingNumber: tracking(raw.id), applicantName: formatApplicantName(raw), applicationType: raw.type,
      applicationId: raw.id, evaluatorName: req.member.name, panelName: req.member.panel?.name, summary: text,
    });
    res.json({ message: "Evaluation submitted to the Registrar" });
  } catch (err) {
    console.error("[panel] submit:", err);
    fail(res, 500, "Could not submit your evaluation");
  }
});

// ───────────────────────── Dashboard summary (staff / chairman) ─────────────────────────

router.get("/summary", requireViewer, async (_req, res) => {
  try {
    await syncPanelTables();
    const statusRows = await Application.findAll({
      attributes: ["status", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
      where: { [Op.or]: [{ draft_type: "COMPLETE" }, { status: "DEFERRED" }], status: { [Op.ne]: "DELETED" } },
      group: ["status"], raw: true,
    });
    const by = {};
    for (const r of statusRows) by[String(r.status || "").toUpperCase()] = parseInt(r.n, 10) || 0;

    const submittedWaiting = await PanelAssignment.count({ where: { status: "SUBMITTED" } });
    const panels = await Panel.findAll({ where: { is_active: true }, order: [["name", "ASC"]] });
    const perPanel = [];
    for (const p of panels) {
      const [open, submitted, done] = await Promise.all([
        PanelAssignment.count({ where: { panel_id: p.id, status: "ASSIGNED" } }),
        PanelAssignment.count({ where: { panel_id: p.id, status: "SUBMITTED" } }),
        PanelAssignment.count({ where: { panel_id: p.id, status: "FORWARDED" } }),
      ]);
      perPanel.push({ id: p.id, name: p.name, open, submitted, forwarded: done });
    }
    const latest = await ApplicationComment.findAll({
      where: { event: { [Op.in]: ["PANEL_COMMENT", "PANEL_EVALUATION"] } },
      order: [["id", "DESC"]], limit: 8, raw: true,
    });
    res.json({
      counts: {
        payment_review: by.SPONSOR_APPROVED || 0,
        awaiting_allocation: by.AWAITING_ALLOCATION || 0,
        panel_review: by.PANEL_REVIEW || 0,
        evaluations_submitted: submittedWaiting,
        deferred: by.DEFERRED || 0,
        board_review: by.ACCOUNTS_APPROVED || 0,
        registration_fee: by.BOARD_APPROVED || 0,
        finalizing: by.FINALIZING || 0,
        registered: (by.REGISTERED || 0) + (by.COMPLETED || 0),
      },
      panels: perPanel,
      latest_comments: latest.map((c) => ({ ...c, tracking_number: tracking(c.application_id) })),
    });
  } catch (err) {
    console.error("[panel] summary:", err);
    fail(res, 500, "Could not load the summary");
  }
});

export default router;
