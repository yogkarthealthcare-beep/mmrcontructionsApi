/**
 * MMR Construction & Developers Pvt. Ltd.
 * Shared Area & Rate Unit Conversion Utility (Backend)
 *
 * Rules:
 * - 1 Gaj (Square Yard) = 9 Sq.Ft (Square Feet)
 * - gajToSqft(g) = g * 9
 * - sqftToGaj(s) = s / 9
 * - ratePerGajToSqft(r) = r / 9
 * - ratePerSqftToGaj(r) = r * 9
 * - Round to 2 decimal places
 */

export function round2(num) {
  if (num === null || num === undefined || isNaN(num)) return 0;
  return Math.round((Number(num) + Number.EPSILON) * 100) / 100;
}

export function gajToSqft(gaj) {
  const g = Number(gaj || 0);
  return round2(g * 9);
}

export function sqftToGaj(sqft) {
  const s = Number(sqft || 0);
  return round2(s / 9);
}

export function ratePerGajToSqft(ratePerGaj) {
  const r = Number(ratePerGaj || 0);
  return round2(r / 9);
}

export function ratePerSqftToGaj(ratePerSqft) {
  const r = Number(ratePerSqft || 0);
  return round2(r * 9);
}

/**
 * Calculate total plot price from either Gaj or Sqft rate.
 * Note: plots.plot_area is stored in GAJ (Sq.Yd).
 * 
 * total = plotAreaInGaj * ratePerGaj
 * OR
 * total = (plotAreaInGaj * 9) * ratePerSqft
 */
export function calculatePlotPrice({
  areaGaj = null,
  areaSqft = null,
  ratePerGaj = null,
  ratePerSqft = null
}) {
  let effectiveAreaGaj = areaGaj !== null && areaGaj !== undefined ? Number(areaGaj) : null;
  if (effectiveAreaGaj === null && areaSqft !== null && areaSqft !== undefined) {
    effectiveAreaGaj = sqftToGaj(areaSqft);
  }

  let effectiveRatePerGaj = ratePerGaj !== null && ratePerGaj !== undefined ? Number(ratePerGaj) : null;
  if (effectiveRatePerGaj === null && ratePerSqft !== null && ratePerSqft !== undefined) {
    effectiveRatePerGaj = ratePerSqftToGaj(ratePerSqft);
  }

  if (!effectiveAreaGaj || !effectiveRatePerGaj) return 0;
  return Math.round(effectiveAreaGaj * effectiveRatePerGaj);
}
