// ── Add a newly registered engineer to erb_engineer ────────────────
// Called when Registration confirms an application (POST /finalize).
//
// erb_engineer isn't modelled anywhere in this codebase, so the insert
// reads the table's real columns first (information_schema) and only fills
// the ones that exist. Known layout (from the live table):
//   id, reg_date ("Oct/13/2022"), organisation, type (PERMANENT/TEMPORARY/
//   TECHNOLOGIST/TECHNICIAN), reg_no ("2281", "TR 271"), name, gender
//   ("M"/"F"), field (discipline, e.g. "Civil"), address, phones, …
// Optional columns such as email / nationality / country / licence fields
// are filled when present.
//
// Idempotent: if reg_no is already in the register, nothing is inserted.

import { QueryTypes } from "sequelize";
import { sequelize } from "../config/database.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "Oct/15/2026" — same style as existing reg_date values. East Africa Time.
const regDate = (d = new Date()) => {
  const eat = new Date(d.getTime() + 3 * 3600 * 1000);
  return `${MONTHS[eat.getUTCMonth()]}/${String(eat.getUTCDate()).padStart(2, "0")}/${eat.getUTCFullYear()}`;
};

const parseJson = (v) => { if (Array.isArray(v)) return v; try { const x = JSON.parse(v || "[]"); return Array.isArray(x) ? x : []; } catch { return []; } };
const clean = (v) => (v == null ? "" : String(v).trim());

// Name in natural order (First Other SURNAME), like existing register rows.
const fullName = (a) => [a.first_name, a.other_names, a.surname].map(clean).filter(Boolean).join(" ") || clean(a.name);

// Most recent employer from the application's positions, if any.
function currentOrganisation(a) {
  const positions = parseJson(a.positions);
  if (!positions.length) return "";
  const sorted = positions.slice().sort((x, y) => new Date(y.start_date || 0) - new Date(x.start_date || 0));
  const current = sorted.find(p => !p.end_date) || sorted[0];
  return clean(current?.organisation || current?.employer);
}

let columnsCache = null;
async function registerColumns() {
  if (!columnsCache) {
    const rows = await sequelize.query(
      "SELECT COLUMN_NAME AS c, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'erb_engineer'",
      { type: QueryTypes.SELECT }
    );
    if (!rows.length) throw new Error("erb_engineer table not found in this database");
    columnsCache = new Map(rows.map(r => [String(r.c).toLowerCase(), r]));
  }
  return columnsCache;
}

/**
 * @param {object} app        erb_applications row (plain object)
 * @param {object} opts
 * @param {string} opts.regNo     issued licence / registration number
 * @param {string} opts.regType   PERMANENT | TEMPORARY | TECHNOLOGIST | TECHNICIAN
 * @returns {Promise<{ inserted: boolean, reason?: string, id?: number }>}
 */
export async function addToEngineerRegister(app, { regNo, regType }) {
  const cols = await registerColumns();

  // Already there? (compare ignoring spaces / slashes / dashes)
  const t = String(regNo).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const existing = await sequelize.query(
    "SELECT id FROM erb_engineer WHERE REPLACE(REPLACE(REPLACE(UPPER(reg_no),' ',''),'/',''),'-','') = :t LIMIT 1",
    { replacements: { t }, type: QueryTypes.SELECT }
  );
  if (existing.length) return { inserted: false, reason: `reg_no ${regNo} already in erb_engineer (id ${existing[0].id})` };

  const gender = clean(app.gender).toUpperCase().startsWith("F") ? "F" : clean(app.gender) ? "M" : "";
  const phone  = [app.telephone, app.alternate_phone].map(clean).filter(Boolean).join(" / ");

  // Candidate values by column name; only columns that exist are used.
  const candidates = {
    reg_date:      regDate(),
    organisation:  currentOrganisation(app),
    type:          regType,
    reg_no:        regNo,
    name:          fullName(app),
    gender,
    field:         clean(app.category),            // discipline, e.g. "Civil"
    address:       clean(app.address),
    phones:        phone,
    phone:         phone,
    telephone:     phone,
    email:         clean(app.email_address),
    emails:        clean(app.email_address),
    email_address: clean(app.email_address),
    nationality:   clean(app.nationality),
    country:       clean(app.country || app.nationality),
    specialization: clean(app.category),
    created_at:    new Date(),
    updated_at:    new Date(),
  };

  const use = Object.entries(candidates).filter(([k, v]) => cols.has(k) && v !== "" && v != null);
  if (!use.some(([k]) => k === "reg_no")) throw new Error("erb_engineer has no reg_no column");

  const names  = use.map(([k]) => `\`${k}\``).join(", ");
  const params = use.map(([k]) => `:${k}`).join(", ");
  const [id] = await sequelize.query(
    `INSERT INTO erb_engineer (${names}) VALUES (${params})`,
    { replacements: Object.fromEntries(use), type: QueryTypes.INSERT }
  );
  return { inserted: true, id, columns: use.map(([k]) => k) };
}
