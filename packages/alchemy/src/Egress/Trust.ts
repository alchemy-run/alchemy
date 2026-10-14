/**
 * Make programs started in a sandbox trust an extra CA: a PEM bundle of the
 * system roots plus that CA, and the env vars each toolchain reads it from.
 * Shared by the Cloudflare interception CA (Runtime/Bootstrap/EgressCa.ts)
 * and the in-sandbox egress proxy's CA (./Proxy.ts).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** Where distributions keep their system root bundle, most common first. */
export const SYSTEM_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt", // Debian, Ubuntu, Alpine
  "/etc/pki/tls/certs/ca-bundle.crt", // RHEL, Fedora
  "/etc/ssl/cert.pem", // macOS, some Alpine
];

const readOr = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

/** The first system root bundle found, or `""`. */
export const systemRoots: Effect.Effect<string, never, FileSystem.FileSystem> = Effect.gen(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const path of SYSTEM_BUNDLES) {
      const roots = yield* readOr(fs, path);
      if (roots) return roots;
    }
    return "";
  },
);

/**
 * Write `path` = system roots + `pems`. Replaces an existing bundle in place
 * (same path, written aside then renamed over it), so a program reading it
 * concurrently sees the old bundle or the new one, never half of either.
 */
export const writeTrustBundle = (path: string, pems: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const roots = yield* systemRoots;
    const next = `${path}.next`;
    yield* fs.writeFileString(next, [roots, ...pems].map((pem) => `${pem.trim()}\n`).join("\n"));
    yield* fs.rename(next, path);
  });

/** The env vars that point each toolchain at the bundle at `bundlePath`. */
export const trustEnv = (bundlePath: string): Record<string, string> => ({
  SSL_CERT_FILE: bundlePath, // OpenSSL, Go (gh), Python
  GIT_SSL_CAINFO: bundlePath, // git over HTTPS
  NODE_EXTRA_CA_CERTS: bundlePath, // Node, Bun
  REQUESTS_CA_BUNDLE: bundlePath, // Python requests
  CURL_CA_BUNDLE: bundlePath, // curl
});
