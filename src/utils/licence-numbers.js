// ── Licence (registration) numbers ──────────────────────────────────
// Issued when Accounts verifies an applicant's registration fee (the
// application then moves to "Finalizing"). One running series per
// registration type:
//
//   PERMANENT    (ERA1)            2281, 2282, 2283 …
//   TEMPORARY    (ERA2)            TR 271, TR 272 …
//   TECHNOLOGIST (ERA3)            ETG 17, ETG 18 …
//   TECHNICIAN   (ERA3)            ETN 39, ETN 40 …
//
// The next value lives in erb_licence_sequences (created on first use) and
// is taken under a row lock, so two Accounts officers verifying at the same
// moment can never get the same number. Before a number is handed out it is
// checked against the existing register (erb_engineer.reg_no), earlier
// applications (erb_applications.license_number) and old_users.licence_no —
// a number already in use anywhere is skipped.
//
// To change a starting point later, edit LICENCE_SERIES *and* the row in
// erb_licence_sequences (the table wins once it exists).

import { QueryTypes } from "sequelize";
import { sequelize } from "../config/database.js";

// Keys match the fee/letter categories used everywhere else
// (CORPORATE = permanent engineer).
export const LICENCE_SERIES = {
  CORPORATE:    { prefix: "",    start: 2281, type: "PERMANENT" },
  TEMPORARY:    { prefix: "TR",  start: 271,  type: "TEMPORARY" },
  TECHNOLOGIST: { prefix: "ETG", start: 17,   type: "TECHNOLOGIST" },
  TECHNICIAN:   { prefix: "ETN", start: 39,   type: "TECHNICIAN" },
};

// Prefixed series carry a space: "TR 271", "ETG 17", "ETN 39".
// Permanent numbers are plain: "2281". (Duplicate checks ignore spaces, so
// an existing "TR271" still blocks "TR 271".)
export const formatLicenceNo = (category, n) => {
  const prefix = LICENCE_SERIES[category]?.prefix ?? "";
  return prefix ? `${prefix} ${n}` : String(n);
};

// Registration type for old_users.type / erb_engineer.type.
export const registrationTypeFor = (category) => LICENCE_SERIES[category]?.type || "PERMANENT";

// Compact form for comparisons: "TR 271", "tr-271", "TR/0271" → "TR271".
const compact = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^([A-Z]*)0+(\d)/, "$1$2");

let tableReady = null;
async function ensureSequenceTable() {
  if (!tableReady) {
    tableReady = (async () => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS erb_licence_sequences (
          category    VARCHAR(20) NOT NULL PRIMARY KEY,
          prefix      VARCHAR(10) NOT NULL DEFAULT '',
          next_value  INT         NOT NULL,
          updated_at  DATETIME    NULL
        )`);
      for (const [category, s] of Object.entries(LICENCE_SERIES)) {
        await sequelize.query(
          `INSERT IGNORE INTO erb_licence_sequences (category, prefix, next_value, updated_at)
           VALUES (:category, :prefix, :start, NOW())`,
          { replacements: { category, prefix: s.prefix, start: s.start } }
        );
      }
    })().catch((err) => { tableReady = null; throw err; });
  }
  return tableReady;
}

// Is this licence number already used anywhere? Each source is checked
// independently — a missing table/column is logged once and skipped rather
// than blocking verification.
const warned = new Set();
async function numberInUse(licenceNo, transaction) {
  const target = compact(licenceNo);
  const checks = [
    { name: "erb_engineer.reg_no",              sql: "SELECT reg_no AS v FROM erb_engineer WHERE REPLACE(REPLACE(REPLACE(UPPER(reg_no),' ',''),'/',''),'-','') = :t LIMIT 1" },
    { name: "erb_applications.license_number",  sql: "SELECT license_number AS v FROM erb_applications WHERE REPLACE(REPLACE(REPLACE(UPPER(license_number),' ',''),'/',''),'-','') = :t LIMIT 1" },
    { name: "old_users.licence_no",             sql: "SELECT licence_no AS v FROM old_users WHERE REPLACE(REPLACE(REPLACE(UPPER(licence_no),' ',''),'/',''),'-','') = :t LIMIT 1" },
  ];
  for (const c of checks) {
    try {
      const rows = await sequelize.query(c.sql, { replacements: { t: target }, type: QueryTypes.SELECT, transaction });
      if (rows.length) return c.name;
    } catch (err) {
      if (!warned.has(c.name)) { warned.add(c.name); console.warn(`[licence-numbers] Skipping ${c.name} check: ${err.message}`); }
    }
  }
  return null;
}

/**
 * Takes the next free licence number for a category.
 * @param {string} category  CORPORATE | TEMPORARY | TECHNOLOGIST | TECHNICIAN
 * @param {object} [opts.transaction]  outer transaction to join (recommended)
 * @returns {Promise<{ licenceNo: string, number: number, skipped: string[] }>}
 */
export async function allocateLicenceNumber(category, { transaction } = {}) {
  if (!LICENCE_SERIES[category]) throw new Error(`Unknown licence category: ${category}`);
  await ensureSequenceTable();

  const run = async (t) => {
    const [row] = await sequelize.query(
      "SELECT next_value FROM erb_licence_sequences WHERE category = :category FOR UPDATE",
      { replacements: { category }, type: QueryTypes.SELECT, transaction: t }
    );
    let n = Number(row?.next_value) || LICENCE_SERIES[category].start;
    const skipped = [];
    // Hard cap so a data problem can never spin forever.
    for (let i = 0; i < 1000; i++, n++) {
      const candidate = formatLicenceNo(category, n);
      const usedIn = await numberInUse(candidate, t);
      if (!usedIn) {
        await sequelize.query(
          "UPDATE erb_licence_sequences SET next_value = :next, updated_at = NOW() WHERE category = :category",
          { replacements: { next: n + 1, category }, transaction: t }
        );
        return { licenceNo: candidate, number: n, skipped };
      }
      skipped.push(`${candidate} (in ${usedIn})`);
    }
    throw new Error(`Could not find a free ${category} licence number after 1000 attempts`);
  };

  return transaction ? run(transaction) : sequelize.transaction(run);
}

/** Next numbers that would be issued — for the admin UI / sanity checks. */
export async function peekLicenceNumbers() {
  await ensureSequenceTable();
  const rows = await sequelize.query("SELECT category, prefix, next_value FROM erb_licence_sequences", { type: QueryTypes.SELECT });
  const out = {};
  for (const r of rows) out[r.category] = { next: formatLicenceNo(r.category, r.next_value), next_value: r.next_value };
  return out;
}
