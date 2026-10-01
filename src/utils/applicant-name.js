// ── Applicant display name ───────────────────────────────────────────
// ERB convention for licence applications: SURNAME, then first name, then
// other names — e.g. "BWEKEMBE Rehemah" rather than "Rehemah BWEKEMBE".
// Built from the three name columns, NOT the free-text `name` column
// (which is whatever order the applicant typed). `name` is only a last
// resort for very old rows that never had the split columns filled in.
const clean = (v) => (v == null ? '' : String(v).trim())

export function formatApplicantName(r) {
  if (!r) return ''
  const parts = [clean(r.surname), clean(r.first_name), clean(r.other_names)].filter(Boolean)
  return parts.length ? parts.join(' ') : clean(r.name)
}
