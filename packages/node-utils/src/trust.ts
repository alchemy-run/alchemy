import { readFileSync } from "node:fs";
import { delimiter } from "node:path";

/**
 * The variable `alchemy dev` sets, before it spawns anything, to the PEM files
 * its providers contribute as trusted CAs, separated by `path.delimiter`. The
 * files may not exist yet.
 */
export const DEV_TRUST_ENV = "ALCHEMY_DEV_TRUST";

// workerd wants one certificate per entry, not a bundle:
// https://github.com/cloudflare/miniflare/pull/587/files#r1271579671
// A PEM body is base64, which never contains `-`, so a BEGIN without its END
// can't swallow the next certificate.
const CERTIFICATE = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g;

/**
 * The CAs a local runtime trusts on top of the system store: the caller's
 * `NODE_EXTRA_CA_CERTS` file, then each file in {@link DEV_TRUST_ENV}, split
 * into single certificates (a bundle is many) with duplicates dropped.
 *
 * Files are read on every call, never cached: a provider's CA can be minted
 * after the process that reads it started, and a file that is missing,
 * unreadable or not PEM just contributes nothing.
 */
export const trustedCertificates = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] => {
  const files = [env.NODE_EXTRA_CA_CERTS, ...(env[DEV_TRUST_ENV]?.split(delimiter) ?? [])];
  // Keyed by the base64 alone: line endings and padding differ between bundles.
  const certificates = new Map<string, string>();
  for (const file of files) {
    if (!file) continue;
    let pem: string;
    try {
      pem = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const certificate of pem.match(CERTIFICATE) ?? []) {
      const key = certificate.replace(/-----[A-Z ]+-----|\s/g, "");
      if (!certificates.has(key)) certificates.set(key, certificate);
    }
  }
  return [...certificates.values()];
};
