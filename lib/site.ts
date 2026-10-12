// Public facts about the site, shared by metadata, the manifest and the
// share image. Nothing secret belongs here.

export const SITE = {
  name: "Farm Korect Nig",
  shortName: "Farm Korect",
  tagline: "Everything poultry, one app",
  description:
    "Farm Korect Nig — the poultry farming and agricultural marketplace for Nigerian farmers. Find vets, buy feed and vaccines, learn, and track your farm's finances.",
  themeColor: "#004b2e",
} as const;

/**
 * The absolute origin that share links and preview images point to. Social
 * apps (WhatsApp, Facebook, X…) need full https URLs, so set APP_URL to the
 * public address in every deployed environment.
 */
export function siteUrl(): URL {
  const configured = process.env.APP_URL?.trim();
  if (configured) return new URL(configured);
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return new URL(`https://${vercel}`);
  return new URL("http://localhost:3000");
}
