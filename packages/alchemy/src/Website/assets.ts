/**
 * How unmatched GET paths are answered. Same names as Cloudflare
 * Workers `assets.notFoundHandling`.
 */
export type WebsiteNotFoundHandling =
  | "none"
  | "single-page-application"
  | "404-page";

/**
 * Static-asset routing on the origin (`notFoundHandling`, `htmlHandling`).
 * CDN/proxy caching is host-specific and is not described here.
 */
export interface WebsiteAssetsProps {
  notFoundHandling?: WebsiteNotFoundHandling;
  htmlHandling?: "none" | "drop-trailing-slash";
}

/** Map {@link WebsiteAssetsProps} onto the generated Node serve entry. */
export const staticConfigFromAssets = (
  assets: WebsiteAssetsProps | undefined,
  defaults?: { notFoundHandling?: WebsiteNotFoundHandling },
): { spa?: boolean; errorPage?: string } => {
  const handling = assets?.notFoundHandling ?? defaults?.notFoundHandling;
  if (handling === "single-page-application") return { spa: true };
  if (handling === "404-page") return { errorPage: "404.html" };
  if (handling === "none") return { spa: false };
  return {};
};
