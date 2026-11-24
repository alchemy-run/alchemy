/** A hostname or domain without case, surrounding space or a trailing dot. */
export const normalizeHostname = (hostname: string) =>
  hostname.trim().replace(/\.$/, "").toLowerCase();

export const sameHostname = (left: string, right: string) =>
  normalizeHostname(left) === normalizeHostname(right);

/** Whether a normalized hostname is dot-separated labels of letters, digits and hyphens. */
export const isPlainHostname = (hostname: string) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(hostname);

/** `*.example.com` for `api.example.com`; a wildcard's base needs two labels. */
export const wildcardOf = (hostname: string) => {
  const labels = hostname.split(".");
  return labels.length >= 3 ? `*.${labels.slice(1).join(".")}` : undefined;
};
