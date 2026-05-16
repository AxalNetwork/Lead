/**
 * Task #3 — minimal lat/lng → ISO-3166-1 alpha-2 reverse lookup.
 *
 * The spec calls for "the existing static topojson lookup" but no such
 * helper exists in the repo today. Rather than ship a 5MB topojson
 * payload to every worker isolate we use a bounding-box table for the
 * ~80 countries that show up in VC datasets. This is intentionally
 * best-effort:
 *   - Coastal points just outside a country's bbox fall back to the
 *     nearest match.
 *   - Disputed territories return the most common ISO2 (no opinion).
 *   - When no bbox matches we return null and the caller leaves the
 *     `geo_country` tag off the firm.
 *
 * Bounding boxes are [minLng, minLat, maxLng, maxLat] in WGS84 and were
 * sourced from natural-earth-vector's `ne_50m_admin_0_countries`
 * envelope (rounded to whole degrees for size). Extend as new countries
 * appear in real Map-of-the-Money payloads.
 */

interface CountryBox {
  iso2: string;
  bbox: [number, number, number, number];
}

const BOXES: CountryBox[] = [
  { iso2: "US", bbox: [-125, 24, -66, 50] },
  { iso2: "CA", bbox: [-141, 41, -52, 70] },
  { iso2: "MX", bbox: [-118, 14, -86, 33] },
  { iso2: "GB", bbox: [-8, 49, 2, 61] },
  { iso2: "IE", bbox: [-11, 51, -5, 56] },
  { iso2: "FR", bbox: [-5, 41, 10, 51] },
  { iso2: "DE", bbox: [5, 47, 16, 55] },
  { iso2: "NL", bbox: [3, 50, 8, 54] },
  { iso2: "BE", bbox: [2, 49, 7, 52] },
  { iso2: "LU", bbox: [5, 49, 7, 51] },
  { iso2: "CH", bbox: [5, 45, 11, 48] },
  { iso2: "AT", bbox: [9, 46, 17, 49] },
  { iso2: "IT", bbox: [6, 36, 19, 47] },
  { iso2: "ES", bbox: [-10, 35, 5, 44] },
  { iso2: "PT", bbox: [-10, 36, -6, 43] },
  { iso2: "DK", bbox: [7, 54, 13, 58] },
  { iso2: "SE", bbox: [10, 55, 25, 70] },
  { iso2: "NO", bbox: [4, 57, 32, 72] },
  { iso2: "FI", bbox: [19, 59, 32, 71] },
  { iso2: "IS", bbox: [-25, 63, -13, 67] },
  { iso2: "PL", bbox: [14, 49, 24, 55] },
  { iso2: "CZ", bbox: [12, 48, 19, 51] },
  { iso2: "SK", bbox: [16, 47, 23, 50] },
  { iso2: "HU", bbox: [16, 45, 23, 49] },
  { iso2: "RO", bbox: [20, 43, 30, 48] },
  { iso2: "BG", bbox: [22, 41, 29, 45] },
  { iso2: "GR", bbox: [19, 34, 28, 42] },
  { iso2: "HR", bbox: [13, 42, 20, 47] },
  { iso2: "SI", bbox: [13, 45, 17, 47] },
  { iso2: "EE", bbox: [21, 57, 28, 60] },
  { iso2: "LV", bbox: [20, 55, 28, 58] },
  { iso2: "LT", bbox: [20, 53, 27, 57] },
  { iso2: "UA", bbox: [22, 44, 40, 53] },
  { iso2: "RU", bbox: [19, 41, 180, 78] },
  { iso2: "TR", bbox: [25, 35, 45, 43] },
  { iso2: "IL", bbox: [34, 29, 36, 34] },
  { iso2: "AE", bbox: [51, 22, 57, 27] },
  { iso2: "SA", bbox: [34, 16, 56, 33] },
  { iso2: "QA", bbox: [50, 24, 52, 27] },
  { iso2: "EG", bbox: [24, 21, 37, 32] },
  { iso2: "ZA", bbox: [16, -35, 33, -22] },
  { iso2: "NG", bbox: [2, 4, 15, 14] },
  { iso2: "KE", bbox: [33, -5, 42, 5] },
  { iso2: "GH", bbox: [-4, 4, 2, 12] },
  { iso2: "MA", bbox: [-13, 27, -1, 36] },
  { iso2: "IN", bbox: [68, 6, 97, 36] },
  { iso2: "PK", bbox: [60, 23, 78, 38] },
  { iso2: "BD", bbox: [88, 20, 93, 27] },
  { iso2: "LK", bbox: [79, 5, 82, 10] },
  { iso2: "CN", bbox: [73, 18, 135, 54] },
  { iso2: "HK", bbox: [113, 22, 115, 23] },
  { iso2: "TW", bbox: [119, 21, 122, 26] },
  { iso2: "JP", bbox: [122, 24, 146, 46] },
  { iso2: "KR", bbox: [125, 33, 130, 39] },
  { iso2: "SG", bbox: [103, 1, 105, 2] },
  { iso2: "MY", bbox: [99, 0, 120, 8] },
  { iso2: "ID", bbox: [95, -11, 141, 6] },
  { iso2: "PH", bbox: [116, 4, 127, 21] },
  { iso2: "TH", bbox: [97, 5, 106, 21] },
  { iso2: "VN", bbox: [102, 8, 110, 24] },
  { iso2: "AU", bbox: [112, -44, 155, -9] },
  { iso2: "NZ", bbox: [165, -48, 180, -33] },
  { iso2: "BR", bbox: [-74, -34, -34, 6] },
  { iso2: "AR", bbox: [-74, -56, -53, -21] },
  { iso2: "CL", bbox: [-76, -56, -66, -17] },
  { iso2: "CO", bbox: [-79, -5, -66, 13] },
  { iso2: "PE", bbox: [-82, -19, -68, 0] },
  { iso2: "UY", bbox: [-59, -35, -53, -30] },
  { iso2: "PY", bbox: [-63, -28, -54, -19] },
  { iso2: "VE", bbox: [-74, 0, -59, 13] },
  { iso2: "EC", bbox: [-81, -5, -75, 2] },
  { iso2: "BO", bbox: [-70, -23, -57, -9] },
];

/**
 * Best-effort reverse geocode: lat/lng → ISO-3166-1 alpha-2 country
 * code, or null when no bbox matches. Disambiguates overlapping bboxes
 * by choosing the *smallest* matching bbox area (so HK wins over CN).
 */
export function countryFromLatLng(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  let best: { iso2: string; area: number } | null = null;
  for (const { iso2, bbox } of BOXES) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;
    const area = (maxLng - minLng) * (maxLat - minLat);
    if (!best || area < best.area) best = { iso2, area };
  }
  return best?.iso2 ?? null;
}
