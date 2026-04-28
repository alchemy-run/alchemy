/**
 * Shared host+path parser for pretty install URLs.
 *
 * Single canonical host (pkg.ing) serves every package. The other hosts
 * are public aliases that 301 to the canonical /projects/:project/tags/:tag.
 *
 *   alchemy.run namespace
 *     hosts:  pkg.ing, pkg.alchemy.run, 📦.alchemy.run
 *     paths (project name == npm package name verbatim):
 *       /<name>/<tag>                 → project "<name>"
 *       /<scope>/<name>/<tag>         → project "<scope>/<name>"
 *
 *   distilled.cloud namespace
 *     hosts:  pkg.distilled.cloud, 📦.distilled.cloud
 *     paths:
 *       /<name>/<tag>                 → project "@distilled.cloud/<name>"
 *
 * Each emoji host has a punycode form (xn--cu8h.*) — Cloudflare normalizes
 * domain config to punycode and that's what the Host header carries.
 */
const CANONICAL_HOST = "pkg.ing";

const ALCHEMY_HOSTS = new Set([
  CANONICAL_HOST,
  "pkg.alchemy.run",
  "xn--cu8h.alchemy.run", // 📦.alchemy.run
]);

const DISTILLED_HOSTS = new Set([
  "pkg.distilled.cloud",
  "xn--cu8h.distilled.cloud", // 📦.distilled.cloud
]);

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
    // /<scope>/<name>/<tag> — scope must be a leading "@" segment.
    if (segments.length === 3 && segments[0]!.startsWith("@")) {
      return { project: `${segments[0]!}/${segments[1]!}`, tag: segments[2]! };
    }
  } else if (DISTILLED_HOSTS.has(h)) {
    // /<name>/<tag> → @distilled.cloud/<name>
    if (segments.length === 2) {
      return {
        project: `@distilled.cloud/${segments[0]!}`,
        tag: segments[1]!,
      };
    }
  }

  return null;
};

// Encode each path segment but keep `/` literal so scoped projects render as
// /projects/@scope/name/... rather than /projects/%40scope%2Fname/... .
const encodePath = (s: string) =>
  s.split("/").map(encodeURIComponent).join("/");

export const aliasRedirectUrl = (match: AliasMatch): string =>
  `https://${CANONICAL_HOST}/projects/${encodePath(match.project)}/tags/${encodeURIComponent(match.tag)}`;
