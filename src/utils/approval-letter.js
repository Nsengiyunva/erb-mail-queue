// ── Board approval letter (PDF) ──────────────────────────────────────
// Generates the "APPLICATION FOR REGISTRATION" approval letter the
// Registration officer attaches when approving an application on behalf
// of the Board. One template per registration category, reproduced from
// the Board's 2026 Word templates:
//
//   CORPORATE    → Engineers_Approval_Letter_2026.docx
//   TEMPORARY    → Temporary_Approval_Letter_2026.docx
//   TECHNOLOGIST → Technologist_Approval_Letter_2026.docx
//   TECHNICIAN   → Technician_Approval_Letter_2026.docx
//
// Category resolution uses the same resolveFeeCategory() the fee schedule
// uses, so the letter, the approval email's fee line and the registration
// payment page can never disagree about which category an applicant is in.
//
// Built with pdfkit (already a dependency, see receipt-pdf.js), so no
// LibreOffice/Word conversion is needed on the server.

import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveFeeCategory, QUOTED_FEES } from "./fee-schedule.js";
import { formatApplicantName } from "./applicant-name.js";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "../assets/approval-letter");
const LOGO_PATH      = path.join(ASSETS_DIR, "erb-logo.png");
const SIGNATURE_PATH = path.join(ASSETS_DIR, "registrar-signature.png");

// Override through .env when the Registrar changes — no code change needed.
const REGISTRAR_NAME  = process.env.ERB_REGISTRAR_NAME  || "Eng. NAMUGERA RONALD";
const REGISTRAR_TITLE = process.env.ERB_REGISTRAR_TITLE || "REGISTRAR, ENGINEERS REGISTRATION BOARD";

const ERB_RED = "#C8102E";

// ── Typeface: Goudy Old Style, as in the Board's Word templates ───────
// Goudy Old Style (GOUDOS*.TTF, ships with MS Office) is a licensed
// Monotype font, so it is not bundled. If the ERB server has licensed
// copies, drop them into src/assets/fonts/ (or point ERB_LETTER_FONT_DIR
// at them) and they are used automatically — regular, bold and italic.
// Otherwise we fall back to Sorts Mill Goudy (bundled, SIL OFL — a
// faithful open revival of Goudy Old Style), which has no bold cut, so
// bold is drawn as a thickened outline ("faux bold").
const FONT_DIRS = [process.env.ERB_LETTER_FONT_DIR, path.resolve(__dirname, "../assets/fonts")].filter(Boolean);
const findFont = (...names) => {
  for (const dir of FONT_DIRS) for (const n of names) {
    for (const cand of [n, n.toLowerCase(), n.toUpperCase()]) {
      const p = path.join(dir, cand);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
};
const LICENSED = {
  regular: findFont("GOUDOS.TTF", "GoudyOldStyle-Regular.ttf"),
  bold:    findFont("GOUDOSB.TTF", "GoudyOldStyle-Bold.ttf"),
  italic:  findFont("GOUDOSI.TTF", "GoudyOldStyle-Italic.ttf"),
};
const OPEN = {
  regular: findFont("SortsMillGoudy-Regular.ttf"),
  italic:  findFont("SortsMillGoudy-Italic.ttf"),
};
const FONT_FILES = LICENSED.regular
  ? { regular: LICENSED.regular, bold: LICENSED.bold, italic: LICENSED.italic || LICENSED.regular, boldItalic: LICENSED.bold || null }
  : OPEN.regular
    ? { regular: OPEN.regular, bold: null, italic: OPEN.italic || OPEN.regular, boldItalic: null }
    : null; // no Goudy at all → built-in Times (closest standard serif)
console.log(`[approval-letter] Letter font: ${LICENSED.regular ? "Goudy Old Style (licensed)" : OPEN.regular ? "Sorts Mill Goudy (open Goudy revival)" : "Times (fallback)"}`);

const BODY_SIZE = 12;

function registerFonts(doc) {
  if (!FONT_FILES) return;
  doc.registerFont("Goudy",        FONT_FILES.regular);
  doc.registerFont("Goudy-Italic", FONT_FILES.italic);
  if (FONT_FILES.bold)       doc.registerFont("Goudy-Bold",       FONT_FILES.bold);
  if (FONT_FILES.boldItalic) doc.registerFont("Goudy-BoldItalic", FONT_FILES.boldItalic);
}

// Sets font + colour for a style. Faux bold (no bold cut available) is
// applied by the doc.text wrapper installed in installFauxBold().
function useFont(doc, style = "regular", color = "#000") {
  const bold = style === "bold" || style === "boldItalic";
  const italic = style === "italic" || style === "boldItalic";
  let name, faux = false;
  if (!FONT_FILES) {
    name = bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman";
  } else if (bold && italic) {
    if (FONT_FILES.boldItalic) name = "Goudy-BoldItalic"; else { name = "Goudy-Italic"; faux = true; }
  } else if (bold) {
    if (FONT_FILES.bold) name = "Goudy-Bold"; else { name = "Goudy"; faux = true; }
  } else {
    name = italic ? "Goudy-Italic" : "Goudy";
  }
  doc._fauxBold = faux;
  doc.font(name).fillColor(color).strokeColor(color);
  return doc;
}

function installFauxBold(doc) {
  const origText = doc.text.bind(doc);
  doc.text = (...args) => {
    const last = args[args.length - 1];
    const opts = (last && typeof last === "object") ? args.pop() : {};
    if (doc._fauxBold) { doc.lineWidth(0.45); args.push({ ...opts, fill: true, stroke: true }); }
    else args.push({ ...opts, fill: true, stroke: false });
    return origText(...args);
  };
}
const PAYMENT_PORTAL_URL = process.env.ERB_PAYMENT_PORTAL_URL || "https://registration.erb.go.ug";

// ── Per-category content ─────────────────────────────────────────────
// `fees` mirror the Word templates' itemisation. The letter itself shows
// only the total (no breakdown) — it is computed from these (and cross-checked against QUOTED_FEES.REGISTRATION
// at module load, see below).
export const LETTER_TEMPLATES = {
  CORPORATE: {
    label:       "Engineer",
    fileLabel:   "Engineers",
    heading:     "APPLICATION FOR REGISTRATION",
    approvedFor: "registration as an Engineer",
    act:         "in accordance with the Engineers Registration Act (ERA), Cap 299.",
    duesMode:    "itemised",
    fees: [
      ["Registration fee",              90000],
      ["Registration Certificate",      50000],
      ["Annual Fees",                  350000],
      ["Annual Practicing Licence",    250000],
      ["Engineers Practicing Stamp",   200000],
      ["ERB Shirt and Lapel Pin",      100000],
    ],
    totalSuffix:  "",
    effected:     "Your registration will be effected after payment of all the above dues.",
    validity:     null,
    congrats:     "Finally, I take this opportunity to congratulate you upon satisfying the Board’s requirements for registration.",
  },

  TEMPORARY: {
    label:       "Temporary Engineer",
    fileLabel:   "Temporary",
    heading:     "APPLICATION FOR TEMPORARY REGISTRATION",
    approvedFor: "temporary registration as an Engineer",
    act:         "in accordance with the Engineers Registration Act (ERA) Cap 299.",
    duesMode:    "lump",
    lumpAmount:  3000000,
    lumpItems: [
      "Registration Fee",
      "Annual Fees & Engineers Practicing Licence and",
      "Annual Engineers Practicing Stamp.",
    ],
    effected:     "Your registration will only be effected after payment of all the above dues.",
    validity:     "Please note that this registration will only be valid for the period of the calendar year of registration. If you want to continue as a registered engineer with the Board, you will be required to apply for renewal of registration.",
    congrats:     "Finally, I take this opportunity to congratulate you upon your satisfying the Board’s requirements for registration.",
  },

  TECHNOLOGIST: {
    label:       "Technologist",
    fileLabel:   "Technologist",
    heading:     "APPLICATION FOR REGISTRATION AS A TECHNOLOGIST",
    approvedFor: "registration as a Technologist",
    act:         "in accordance with the Engineers Registration Act (ERA) Cap 299.",
    duesMode:    "itemised",
    fees: [
      ["Registration fee",                                      200000],
      ["Triennial fees & Practicing Licence (for 3 Years)",     450000],
      ["ERB Shirt and Lapel Pin",                               100000],
    ],
    totalSuffix:  " for Three (3) Years after which you will have to pay for renewal of a practicing licence.",
    effected:     "Your registration will be effected after payment of all the above dues.",
    validity:     "Please note that this registration will only be valid for a Triennial period of the calendar year of registration. If you want to continue as a registered Technologist with the Board, you will be required to apply for renewal of registration.",
    congrats:     "Finally, I take this opportunity to congratulate you upon satisfying the Board’s requirements for registration as a Technologist.",
  },

  TECHNICIAN: {
    label:       "Technician",
    fileLabel:   "Technician",
    heading:     "APPLICATION FOR REGISTRATION AS A TECHNICIAN",
    approvedFor: "registration as a Technician",
    act:         "in accordance with the Engineers Registration Act (ERA) Cap 299.",
    duesMode:    "itemised",
    fees: [
      ["Registration fee",                                      200000],
      ["Triennial fees & Practicing Licence (for 3 Years)",     300000],
      ["ERB Shirt and Lapel Pin",                               100000],
    ],
    totalSuffix:  " for Three (3) Years after which you will have to pay for renewal of a practicing licence.",
    effected:     "Your registration will be effected after payment of all the above dues.",
    validity:     "Please note that this registration will only be valid for a Triennial period of the calendar year of registration. If you want to continue as a registered Technician with the Board, you will be required to apply for renewal of registration.",
    congrats:     "Finally, I take this opportunity to congratulate you upon satisfying the Board’s requirements for registration as a Technician.",
  },
};

const templateTotal = (t) =>
  t.duesMode === "lump" ? t.lumpAmount : t.fees.reduce((s, [, amt]) => s + amt, 0);

// Loud (but non-fatal) warning if the letter fees ever drift from the fee
// schedule the payment pages charge against.
for (const [key, t] of Object.entries(LETTER_TEMPLATES)) {
  const expected = QUOTED_FEES?.REGISTRATION?.[key];
  if (expected != null && expected !== templateTotal(t)) {
    console.warn(`[approval-letter] ${key} letter total ${templateTotal(t)} ≠ QUOTED_FEES.REGISTRATION ${expected} — update one of them.`);
  }
}

// Which letter template (and registration fee) applies — driven by the
// APPLICATION TYPE, not the discipline:
//   ERA1 → Engineer (CORPORATE)
//   ERA2 → Temporary
//   ERA3 → Technologist or Technician — from `profession`, which the
//          wizard sets to "Technician" / "Technologist" for ERA3
// `category` often holds the discipline ("Civil"), so it is only used as a
// hint, never as the deciding field.
const techHint = (v) => {
  const s = String(v || "").toLowerCase();
  if (s.includes("technici")) return "TECHNICIAN";
  if (s.includes("technolo")) return "TECHNOLOGIST";
  return null;
};
export function letterCategoryFor(application) {
  const type = String(application?.type || "").trim().toUpperCase();
  const prof = application?.profession;
  const cat  = application?.category;
  if (type === "ERA2") return "TEMPORARY";
  if (type === "ERA3") return techHint(prof) || techHint(cat) || "TECHNOLOGIST";
  if (type === "ERA1") return "CORPORATE";
  // Unknown/legacy type: fall back to profession, then category.
  if (/temp/i.test(String(prof || "")) || /temp/i.test(String(cat || ""))) return "TEMPORARY";
  return techHint(prof) || techHint(cat) || resolveFeeCategory(prof || cat);
}

// Category for the registration fee once approved: whatever the approval
// letter actually said (officer may have overridden the template), else
// the type-based default above.
export function registrationCategoryFor(application) {
  try {
    const meta = application?.approval_letter_meta ? JSON.parse(application.approval_letter_meta) : null;
    if (meta?.category && LETTER_TEMPLATES[meta.category]) return meta.category;
  } catch { /* bad JSON → default */ }
  return letterCategoryFor(application);
}

export const LETTER_TEMPLATE_OPTIONS = () =>
  Object.entries(LETTER_TEMPLATES).map(([key, t]) => ({ key, label: t.label, heading: t.heading }));

// ── Formatting helpers ──────────────────────────────────────────────
const ordinal = (n) => {
  const v = Math.abs(Number(n)) % 100;
  const suffix = (v >= 11 && v <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[v % 10] || "th");
  return `${n}${suffix}`;
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Accepts a Date or "YYYY-MM-DD"; renders "28th October 2026". Date-only
// strings are read as calendar dates (no timezone shift).
export function formatLetterDate(value) {
  let y, m, d;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    [y, m, d] = value.slice(0, 10).split("-").map(Number);
  } else {
    const dt = value ? new Date(value) : new Date();
    if (Number.isNaN(dt.getTime())) return String(value || "");
    // Calendar date in East Africa Time (UTC+3) regardless of server TZ.
    const eat = new Date(dt.getTime() + 3 * 3600 * 1000);
    y = eat.getUTCFullYear(); m = eat.getUTCMonth() + 1; d = eat.getUTCDate();
  }
  return `${ordinal(d)} ${MONTHS[m - 1]} ${y}`;
}

export const todayISO = () => {
  const eat = new Date(Date.now() + 3 * 3600 * 1000);
  return eat.toISOString().slice(0, 10);
};

const fmtUGX = (n) => Number(n).toLocaleString("en-US");

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function under1000(n) {
  const parts = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20)  { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "")); }
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(" ");
}
// 1040000 → "One Million Forty Thousand" (ERB letters omit "and").
export function amountInWords(n) {
  n = Math.floor(Number(n) || 0);
  if (n === 0) return "Zero";
  const scales = [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"]];
  const out = [];
  for (const [size, name] of scales) {
    if (n >= size) { out.push(`${under1000(Math.floor(n / size))} ${name}`); n %= size; }
  }
  if (n > 0) out.push(under1000(n));
  return out.join(" ");
}

const SALUTATIONS = ["Mr.", "Ms.", "Mrs.", "Dr.", "Eng.", "Prof."];

export function defaultSalutation(application) {
  const g = String(application?.gender || "").trim().toLowerCase();
  if (g.startsWith("f")) return "Ms.";
  if (g.startsWith("m")) return "Mr.";
  return "";
}

// The application only has a single free-text `address` — split it into
// letter lines on newlines / commas. The officer can edit these before
// generating; defaults to the template's "KAMPALA, UGANDA." last line
// only when nothing usable is on file.
export function defaultAddressLines(application) {
  const raw = String(application?.address || "").trim();
  if (!raw) return ["KAMPALA, UGANDA."];
  let parts = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 1) parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  // Template style: last line is "TOWN, COUNTRY." in capitals.
  const COUNTRY_RE = /uganda|kenya|tanzania|rwanda|burundi|sudan|congo/i;
  const last = parts[parts.length - 1] || "";
  if (parts.length >= 2 && COUNTRY_RE.test(last) && !last.includes(",")) {
    const country = parts.pop().replace(/\.$/, "");
    const town    = parts.pop().replace(/,$/, "");
    parts.push(`${town.toUpperCase()}, ${country.toUpperCase()}.`);
  } else if (COUNTRY_RE.test(last) && last.includes(",")) {
    parts[parts.length - 1] = `${last.replace(/\.$/, "").toUpperCase()}.`;
  }
  return parts.slice(0, 5);
}

export function defaultReferenceNo(application) {
  return `ERB/2/${String(application?.id ?? "").padStart(5, "0")}`;
}

// Surname for "Dear Mr. Surname," — ERB stores the surname separately.
const salutationName = (application) =>
  String(application?.surname || "").trim() || formatApplicantName(application).split(/\s+/)[0] || "Sir/Madam";

// Normalise whatever the officer submitted into a complete options object.
export function resolveLetterOptions(application, input = {}) {
  // Officer may override the template (e.g. an ERA3 applicant whose
  // Technician/Technologist choice is missing); otherwise type-based.
  const override = String(input.template || "").trim().toUpperCase();
  const category = LETTER_TEMPLATES[override] ? override : letterCategoryFor(application);
  const salutation = SALUTATIONS.includes(String(input.salutation || "").trim())
    ? String(input.salutation).trim()
    : (input.salutation === "" ? "" : defaultSalutation(application));
  const addressLines = Array.isArray(input.address_lines)
    ? input.address_lines.map(s => String(s || "").trim()).filter(Boolean).slice(0, 6)
    : (typeof input.address_lines === "string"
        ? input.address_lines.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 6)
        : defaultAddressLines(application));

  return {
    category,
    meeting_number: String(input.meeting_number ?? "").replace(/\D/g, "") || null,
    meeting_date:   input.meeting_date || null,
    letter_date:    input.letter_date  || todayISO(),
    reference_no:   String(input.reference_no || "").trim() || defaultReferenceNo(application),
    salutation,
    address_lines:  addressLines.length ? addressLines : defaultAddressLines(application),
    recipient_name: String(input.recipient_name || "").trim() || formatApplicantName(application),
  };
}

export function validateLetterOptions(opts) {
  const errors = [];
  if (!opts.meeting_number) errors.push("Board meeting number is required (e.g. 418).");
  if (!opts.meeting_date)   errors.push("Board meeting date is required.");
  return errors;
}

export function approvalLetterFilename(application, category) {
  const t = LETTER_TEMPLATES[category] || LETTER_TEMPLATES.CORPORATE;
  return `ERB-${String(application?.id ?? "").padStart(5, "0")}-${t.fileLabel}-Approval-Letter.pdf`;
}

// ── PDF rendering ───────────────────────────────────────────────────
const PAGE = { left: 62, right: 62, top: 34 };

// Writes a run of {text, bold} segments as one justified paragraph.
// pdfkit mis-justifies lines that mix fonts (huge word gaps), so mixed
// paragraphs are left-aligned; single-run paragraphs stay justified.
function richParagraph(doc, segments, { size = BODY_SIZE, gap = 9, align = segments.length > 1 ? "left" : "justify" } = {}) {
  segments.forEach((seg, i) => {
    useFont(doc, seg.bold ? "bold" : "regular", seg.color || "#000").fontSize(size);
    doc.text(seg.text, {
      continued: i < segments.length - 1, align, lineGap: 1.5,
      underline: !!seg.underline,
      ...(seg.link ? { link: seg.link } : { link: null }),
    });
  });
  useFont(doc, "regular");
  doc.moveDown(gap / 12);
}

function paragraph(doc, text, opts = {}) {
  richParagraph(doc, [{ text }], opts);
}

function drawLetterhead(doc, referenceNo) {
  const pageW  = doc.page.width;
  const top    = PAGE.top;
  const left   = PAGE.left - 14;
  const right  = pageW - PAGE.right + 14;

  // Left: contacts
  const labelX = left, valueX = left + 62;
  const rows = [["Telephone:", "+256 - 39- 3194942"], ["Email:", "info@erb.go.ug"], ["Website:", "www.erb.go.ug"]];
  rows.forEach(([label, value], i) => {
    const y = top + i * 15;
    useFont(doc, "bold").fontSize(10).text(label, labelX, y, { lineBreak: false });
    const isLink = label === "Website:";
    useFont(doc, "bold", isLink ? "#1d4ed8" : "#000").fontSize(10)
       .text(value, valueX, y, { width: 120, lineBreak: false, underline: isLink, ...(isLink ? { link: "https://www.erb.go.ug" } : {}) });
  });
  doc.fillColor("#000");

  // Centre: logo + motto
  const logoSize = 74;
  const logoX = (pageW - logoSize) / 2;
  if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, logoX, top - 6, { width: logoSize, height: logoSize });
  useFont(doc, "boldItalic", ERB_RED).fontSize(8.5)
     .text("For Engineering Excellence", logoX - 30, top + logoSize - 2, { width: logoSize + 60, align: "center" });
  doc.fillColor("#000");

  // Right: postal address
  const rx = right - 150;
  ["Engineers Registration Board,", "P.O. Box 29267,", "Kampala, UGANDA."].forEach((line, i) => {
    useFont(doc, "bold").fontSize(10).text(line, rx, top + i * 15, { width: 150, lineBreak: false });
  });

  // Reference
  const refY = top + 62;
  useFont(doc, "bold").fontSize(10.5)
     .text("In any correspondence on this subject", left + 8, refY, { width: 200 })
     .text(`please quote No: ${referenceNo}`, left + 8, doc.y, { width: 220 });

  doc.x = PAGE.left;
  doc.y = Math.max(doc.y, top + logoSize + 18) + 14;
}

/**
 * Renders the approval letter for one application.
 * @param {object} application  erb_applications row (plain object)
 * @param {object} input        officer-supplied options (see resolveLetterOptions)
 * @returns {Promise<{ buffer: Buffer, options: object, filename: string }>}
 */
export function renderApprovalLetter(application, input = {}) {
  const options  = resolveLetterOptions(application, input);
  const template = LETTER_TEMPLATES[options.category] || LETTER_TEMPLATES.CORPORATE;
  const filename = approvalLetterFilename(application, options.category);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: PAGE.top, bottom: 40, left: PAGE.left, right: PAGE.right },
        info: {
          Title:   `${template.heading} — ${options.recipient_name}`,
          Author:  "Engineers Registration Board",
          Subject: `Board approval letter (${template.label})`,
        },
      });
      registerFonts(doc);
      installFauxBold(doc);
      useFont(doc, "regular").fontSize(BODY_SIZE);
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve({ buffer: Buffer.concat(chunks), options, filename }));
      doc.on("error", reject);

      drawLetterhead(doc, options.reference_no);

      const width = doc.page.width - PAGE.left - PAGE.right;
      const body  = (fn) => { doc.x = PAGE.left; fn(); };

      // Date + addressee
      body(() => {
        useFont(doc, "regular").fontSize(BODY_SIZE).text(formatLetterDate(options.letter_date), { width });
        doc.moveDown(0.9);
        const nameLine = [options.salutation, options.recipient_name].filter(Boolean).join(" ");
        doc.text(nameLine, { width });
        options.address_lines.forEach((line, i) => {
          const last = i === options.address_lines.length - 1;
          doc.text(line.replace(/,?$/, last ? "" : ","), { width, underline: last });
        });
        doc.moveDown(0.9);
        doc.text(`Dear ${[options.salutation, salutationName(application)].filter(Boolean).join(" ")},`, { width });
        doc.moveDown(0.9);
        useFont(doc, "bold").text(template.heading, { width, underline: true });
        useFont(doc, "regular");
        doc.moveDown(0.8);
      });

      const meetingDate = options.meeting_date ? formatLetterDate(options.meeting_date) : "________";
      const meetingNo   = options.meeting_number ? ordinal(options.meeting_number) : "____";
      richParagraph(doc, [
        { text: "This is to inform you that the Engineers Registration Board at their " },
        { text: `${meetingNo} `, bold: true },
        { text: "meeting held on " },
        { text: `${meetingDate} `, bold: true },
        { text: `approved your application for ${template.approvedFor}, ${template.act}` },
      ]);

      // Fees: total only (no itemised breakdown), then online payment.
      const total = templateTotal(template);
      if (template.duesMode === "lump") {
        paragraph(doc, `You are therefore accordingly required to pay Ug. Shs. ${fmtUGX(total)} (${amountInWords(total)} Shillings Only) to the Engineers Registration Board.`);
      } else {
        paragraph(doc, `You are therefore accordingly required to pay a total of Ug. Shs. ${fmtUGX(total)} (${amountInWords(total)} Shillings Only) to the ERB${template.totalSuffix || "."}`);
      }

      richParagraph(doc, [
        { text: "All payments should be made online: " },
        { text: PAYMENT_PORTAL_URL, bold: true, link: PAYMENT_PORTAL_URL, color: "#1d4ed8", underline: true },
      ]);

      paragraph(doc, `${template.effected} This offer however lapses if the above dues are not paid within a period of one month from the date of this letter.`);
      if (template.validity) paragraph(doc, template.validity);
      paragraph(doc, template.congrats);

      // Signature block — keep it together on one page.
      if (doc.y + 110 > doc.page.height - 40) doc.addPage();
      body(() => {
        if (fs.existsSync(SIGNATURE_PATH)) doc.image(SIGNATURE_PATH, PAGE.left, doc.y + 2, { width: 78 });
        doc.y += 42;
        useFont(doc, "bold").fontSize(BODY_SIZE).text(REGISTRAR_NAME, PAGE.left, doc.y, { width });
        useFont(doc, "bold").fontSize(10.5).text(REGISTRAR_TITLE, { width, underline: true });
        doc.moveDown(0.5);
        useFont(doc, "regular").fontSize(BODY_SIZE).text("c.c. Chairman, Engineers Registration Board", { width });
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Renders the letter and writes it into `dir`; returns { filename, filePath, options }. */
export async function saveApprovalLetter(application, input, dir) {
  const { buffer, options, filename } = await renderApprovalLetter(application, input);
  const stored = `${Date.now()}-${filename}`;
  const filePath = path.join(dir, stored);
  await fs.promises.writeFile(filePath, buffer);
  return { filename: stored, displayName: filename, filePath, options };
}
