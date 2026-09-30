// ── ERB fee schedule — nominal (quoted) fees ─────────────────────────
export const QUOTED_FEES = {
  APPLICATION: {
    CORPORATE:    400000,
    TEMPORARY:    400000,
    TECHNOLOGIST: 200000,
    TECHNICIAN:   100000,
  },
  REGISTRATION: {
    CORPORATE:    1040000,
    TEMPORARY:    3000000,
    TECHNOLOGIST:  750000,
    TECHNICIAN:    600000,
  },
  RENEWAL: {
    CORPORATE:     600000,
    TEMPORARY:    1800000,
    TECHNOLOGIST:  650000,
    TECHNICIAN:    500000,
  },
}

// Same category-matching convention already used across the frontend
export function resolveFeeCategory(category) {
  const c = String(category || '').toLowerCase().trim()
  if (c.startsWith('temp'))     return 'TEMPORARY'
  if (c.startsWith('technici')) return 'TECHNICIAN'
  if (c.startsWith('technolo')) return 'TECHNOLOGIST'
  return 'CORPORATE'
}

// Looks up the nominal fee for a purpose ('APPLICATION' | 'REGISTRATION'

export function resolveQuotedFee(purpose, category) {
  const table = QUOTED_FEES[String(purpose || '').toUpperCase()]
  if (!table) return null
  return table[resolveFeeCategory(category)] ?? null
}

// ── Charged (gateway-inclusive) amount → ERB fee ─────────────────────
// Online payments are stored at what the payer was actually charged —
// the ERB fee plus Mobile Money / FlexiPay charges (e.g. UGX 609,150 for a
// UGX 600,000 Permanent renewal). Admin screens should show the ERB fee.
// Same table as ERB_FEE_MAP in the frontend TrackPayments.js and in
// utils/receipt-pdf.js — keep all three in sync.
export const ERB_FEE_BY_CHARGED = {
  406100:  400000,    // Application — Permanent / Temporary
  203050:  200000,    // Application — Technologist
  101560:  100000,    // Application — Technician
  1055900: 1040000,   // Registration — Permanent
  3045700: 3000000,   // Registration — Temporary
  761450:  750000,    // Registration — Technologist
  609150:  600000,    // Registration — Technician / Renewal — Permanent
  1827430: 1800000,   // Renewal — Temporary
  659920:  650000,    // Renewal — Technologist
  507650:  500000,    // Renewal — Technician
}

// Best available ERB fee for a PaymentTransaction row: the quoted_amount
// recorded at payment time, else the charged → fee table, else the raw
// amount (already an ERB fee for attached-receipt payments).
export function erbFeeFor(tx) {
  if (!tx) return null
  if (tx.quoted_amount != null) return Number(tx.quoted_amount)
  const n = Number(tx.amount)
  if (!Number.isFinite(n)) return null
  return ERB_FEE_BY_CHARGED[n] ?? n
}
