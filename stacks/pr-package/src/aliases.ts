/**
 * Shared host+path parser for pretty install URLs.
 *
 * Maps incoming `(host, pathname)` to a `(project, tag)` on the canonical
 * 📦.alchemy.run API. Used by both the Redirect worker (legacy hosts) and
 * the Api worker (so the canonical host serves the same pretty URLs).
 *
 *   pkg.alchemy.run/alchemy/<tag>                → alchemy
 *   pkg.alchemy.run/@alchemy.run/<name>/<tag>    → <name>
 *   pkg.distilled.cloud/<name>/<tag>             → distilled-<name>
 *
 * Each pkg.* host has an emoji-prefixed alias (📦.alchemy.run /
 * 📦.distilled.cloud) — Cloudflare stores those as their punycode form
 * (xn--cu8h.*), which is what the Host header carries at request time.
 */
const ALCHEMY_HOSTS = new Set([
  "pkg.alchemy.run",
  "xn--cu8h.alchemy.run", // 📦.alchemy.run
]);

const DISTILLED_HOSTS = new Set([
  "pkg.distilled.cloud",
  "xn--cu8h.distilled.cloud", // 📦.distilled.cloud
]);

export const CANONICAL_HOST = "xn--cu8h.alchemy.run"; // 📦.alchemy.run

const normalizeHost = (h: string): string => {
  try {
    return new URL(`https://${h}`).hostname;
  } catch {
    return h.toLowerCase();
  }
};

export type AliasMatch = { project: string; tag: string };

export const parseAlias = (
  host: string | undefined,
  pathname: string,
): AliasMatch | null => {
  const h = normalizeHost(host ?? "");
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  if (ALCHEMY_HOSTS.has(h)) {
    // /<name>/<tag>
    if (segments.length === 2) {
      return { project: segments[0]!, tag: segments[1]! };
    }
    // /@alchemy.run/<name>/<tag>
    if (segments.length === 3 && segments[0] === "@alchemy.run") {
      return { project: segments[1]!, tag: segments[2]! };
    }
  } else if (DISTILLED_HOSTS.has(h)) {
    // /<name>/<tag> → distilled-<name>
    if (segments.length === 2) {
      return { project: `distilled-${segments[0]!}`, tag: segments[1]! };
    }
  }

  return null;
};

export const aliasRedirectUrl = (match: AliasMatch): string =>
  `https://${CANONICAL_HOST}/projects/${encodeURIComponent(match.project)}/tags/${encodeURIComponent(match.tag)}`;
