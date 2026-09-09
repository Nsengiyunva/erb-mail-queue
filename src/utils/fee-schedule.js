// ── ERB fee schedule — nominal (quoted) fees ─────────────────────────
// The amount a payment actually clears for (PaymentTransaction.amount,
// or `payment_amount` sent to the FlexiPay gateway) includes the payment
// gateway's own charge on top of ERB's fee — that's the figure that
// shows up in the Payment Tracker and is what was genuinely collected.
// Receipts and emails must NEVER quote that figure — they quote the
// nominal ERB fee below, which is also what applicants are shown as
// "what you're paying for" during checkout (see computeFeeLabel in
// SectionF.js, ACTUAL_REGISTRATION_FEES in DisplayApplication.js, and
// RENEWAL_FEES in the Renewals payment screens — this table is the
// backend mirror of those, used only as a fallback for older
// transactions that predate `quoted_amount` being sent and stored per
// transaction).
//
// Source: Finance-provided fee schedule (see conversation), matches
// exactly what the three frontend fee tables above already encode.
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
// (RenewalInstantPayment.js, RenewalPayment.js, DisplayApplication.js):
// prefix-match on a free-text category/profession string, defaulting to
// CORPORATE (the "Permanent" category) when nothing else matches.
export function resolveFeeCategory(category) {
  const c = String(category || '').toLowerCase().trim()
  if (c.startsWith('temp'))     return 'TEMPORARY'
  if (c.startsWith('technici')) return 'TECHNICIAN'
  if (c.startsWith('technolo')) return 'TECHNOLOGIST'
  return 'CORPORATE'
}

// Looks up the nominal fee for a purpose ('APPLICATION' | 'REGISTRATION'
// | 'RENEWAL') and a free-text category/profession string. Returns null
// if the purpose isn't recognised (never guesses across purposes).
export function resolveQuotedFee(purpose, category) {
  const table = QUOTED_FEES[String(purpose || '').toUpperCase()]
  if (!table) return null
  return table[resolveFeeCategory(category)] ?? null
}
