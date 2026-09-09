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
