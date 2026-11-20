// Panel-review module — models.
//
// A PANEL is a group of engineers who review newly submitted applications
// before they reach the Board. Each panel has one chairperson. After Accounts
// verifies an application's payment, the Registrar / Registration Officer
// allocates it to a panel and to ONE panel member (an assignment). Panel
// members evaluate only their own assignments; their comments are internal.
//
// Same self-creating-table pattern as ApplicationComment: sync() only ever
// creates a missing table, it never alters or drops an existing one.
import { DataTypes } from "sequelize";
import { sequelize } from "../config/database.js";

const define = (name, attrs, opts) =>
  sequelize.models[name] || sequelize.define(name, attrs, opts);

export const Panel = define(
  "Panel",
  {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name:        { type: DataTypes.STRING(120), allowNull: false },
    description: DataTypes.STRING(255),
    is_active:   { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { tableName: "erb_panels", timestamps: true, createdAt: "created_at", updatedAt: "updated_at" }
);

export const PanelMember = define(
  "PanelMember",
  {
    id:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    panel_id: { type: DataTypes.INTEGER, allowNull: false },
    // Matches the e-mail of the member's system user (level PANEL) on
    // data.erb.go.ug — this is how a logged-in user is recognised as a member.
    email:    { type: DataTypes.STRING(190), allowNull: false },
    name:     { type: DataTypes.STRING(160), allowNull: false },
    // One chairperson per panel (enforced in panel_routes.js).
    is_chair:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "erb_panel_members",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ fields: ["panel_id"] }, { fields: ["email"] }],
  }
);

export const PanelAssignment = define(
  "PanelAssignment",
  {
    id:             { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    application_id: { type: DataTypes.BIGINT, allowNull: false },
    panel_id:       { type: DataTypes.INTEGER, allowNull: false },
    member_id:      { type: DataTypes.INTEGER, allowNull: false },
    assigned_by:    DataTypes.STRING(160),
    assigned_by_role: DataTypes.STRING(40),
    // ASSIGNED   → member is working on it
    // SUBMITTED  → member sent their evaluation to the Registrar
    // SUPERSEDED → re-assigned, or the application was deferred to the applicant
    // FORWARDED  → Registrar sent the application on to Board review
    status:         { type: DataTypes.STRING(20), allowNull: false, defaultValue: "ASSIGNED" },
    // 1 for the first allocation; +1 every time the application returns to the pool.
    round:          { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    submitted_at:   DataTypes.DATE,
    // Queue job id of the "you have been assigned" e-mail, so staff can see
    // whether it was sent (looked up in erb_email_logs) and re-send it.
    email_job_id:   DataTypes.STRING(120),
  },
  {
    tableName: "erb_panel_assignments",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ fields: ["application_id"] }, { fields: ["member_id", "status"] }, { fields: ["panel_id"] }],
  }
);

PanelMember.belongsTo(Panel, { foreignKey: "panel_id", as: "panel" });
Panel.hasMany(PanelMember, { foreignKey: "panel_id", as: "members" });
PanelAssignment.belongsTo(PanelMember, { foreignKey: "member_id", as: "member" });
PanelAssignment.belongsTo(Panel, { foreignKey: "panel_id", as: "panel" });

let synced = false;
// ── Earlier versions of an applicant's documents ─────────────────────────────
// When an applicant replaces a document after the application was sent back,
// the previous file is NOT deleted: it is filed here as an earlier version so
// the Registrar, the allocated panel member and the panel chairperson can still
// open what was originally submitted. (Applicants never see these.)
export const ApplicationDocumentVersion = define(
  "ApplicationDocumentVersion",
  {
    id:             { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    application_id: { type: DataTypes.BIGINT, allowNull: false },
    doc_key:        { type: DataTypes.STRING(60), allowNull: false },   // application column, e.g. technical_path
    doc_title:      DataTypes.STRING(120),
    file_name:      { type: DataTypes.STRING(400), allowNull: false },  // the replaced file in the uploads folder
    version_no:     { type: DataTypes.INTEGER, allowNull: false },      // 1 = the first file submitted
    uploaded_at:    DataTypes.DATE,                                     // when this file was uploaded (from its name)
    replaced_by:    DataTypes.STRING(160),
    reason:         { type: DataTypes.STRING(60), defaultValue: "REPLACED_AFTER_SEND_BACK" },
  },
  {
    tableName: "erb_application_document_versions",
    timestamps: true,
    createdAt: "replaced_at",
    updatedAt: false,
    indexes: [{ fields: ["application_id", "doc_key"] }],
  }
);

// multer names uploads "<Date.now()>-<original name>"; recover the upload time.
export function uploadedAtFromName(fileName) {
  const m = /^(\d{13})-/.exec(String(fileName || ""));
  return m ? new Date(Number(m[1])) : null;
}

export async function archiveReplacedDocument({ applicationId, column, title, oldFile, newFile, by }) {
  if (!oldFile || oldFile === newFile) return null;
  await syncPanelTables();
  const n = await ApplicationDocumentVersion.count({ where: { application_id: applicationId, doc_key: column } });
  return ApplicationDocumentVersion.create({
    application_id: applicationId, doc_key: column, doc_title: title, file_name: String(oldFile).split("/").pop(),
    version_no: n + 1, uploaded_at: uploadedAtFromName(oldFile), replaced_by: by || "Applicant",
  });
}

async function ensureColumn(table, column, type) {
  const qi = sequelize.getQueryInterface();
  const cols = await qi.describeTable(table);
  if (!cols[column]) await qi.addColumn(table, column, { type });
}

export function syncPanelTables() {
  if (synced) return Promise.resolve();
  synced = true;
  return Panel.sync()
    .then(() => PanelMember.sync())
    .then(() => PanelAssignment.sync())
    .then(() => ensureColumn("erb_panel_assignments", "email_job_id", DataTypes.STRING(120)))
    .then(() => ApplicationDocumentVersion.sync())
    .catch((err) => {
      synced = false;
      console.error("[panel] table sync error:", err.message);
    });
}

// Statuses used by the panel stage. Board review stays ACCOUNTS_APPROVED, so
// everything downstream of the Board is untouched.
export const PANEL_STATUS = {
  AWAITING_ALLOCATION: "AWAITING_ALLOCATION",
  PANEL_REVIEW:        "PANEL_REVIEW",
  BOARD_REVIEW:        "ACCOUNTS_APPROVED",
};

// Marks any live assignment on an application as SUPERSEDED. Used when the
// application is deferred to the applicant (it will be re-allocated from the
// pool after resubmission) and when it is re-assigned.
export async function supersedeActiveAssignments(applicationId) {
  try {
    await syncPanelTables();
    await PanelAssignment.update(
      { status: "SUPERSEDED" },
      { where: { application_id: applicationId, status: ["ASSIGNED", "SUBMITTED"] } }
    );
  } catch (err) {
    console.error(`[panel] could not supersede assignments for application ${applicationId}:`, err.message);
  }
}
