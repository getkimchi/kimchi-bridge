/**
 * Canonical platform API URL, vendored from Kimchi's regions.ts. Accounts and billing
 * sources captured before the platform API moved to the region's API origin hold the
 * legacy `webAppUrl + "/api"` base; comparisons must treat both spellings as equal in
 * upgrade and rollback. Only the region table fields the canonicalization reads moved.
 */

interface RegionEndpoints {
  /** Base URL of the Kimchi web app (login pages, billing links, platform API). */
  webAppUrl: string;
  /** Base URL of the Cast AI API (key validation, telemetry, stats). */
  castApiUrl: string;
}

const REGIONS: Record<string, RegionEndpoints> = {
  us: { webAppUrl: "https://app.kimchi.dev", castApiUrl: "https://api.cast.ai" },
  eu: { webAppUrl: "https://app.eu.kimchi.dev", castApiUrl: "https://api.eu.cast.ai" },
  // Self-hosted has no fixed URLs; the empty webAppUrl keeps it skipped below, as in Kimchi.
  "self-hosted": { webAppUrl: "", castApiUrl: "" },
};

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

export function canonicalPlatformApiUrl(url: string): string {
  const trimmed = stripTrailingSlashes(url);
  for (const region of Object.values(REGIONS)) {
    if (!region.webAppUrl) continue; // self-hosted placeholder has no fixed URLs
    if (trimmed === `${region.webAppUrl}/api`) return region.castApiUrl;
  }
  return trimmed;
}
