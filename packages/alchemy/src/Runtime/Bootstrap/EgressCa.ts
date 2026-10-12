/**
 * Trust the per-instance CA a Cloudflare container's HTTPS interception
 * presents (see Cloudflare/Containers/Egress.ts). Programs started from the
 * container (git, gh, a harness CLI) verify TLS against a bundle of the
 * system roots plus that CA; the bundle is rebuilt when the CA appears or
 * changes, which can be after this process starts.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";

/** Where the platform writes the interception CA. */
export const EGRESS_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/** System roots plus the interception CA. */
export const EGRESS_CA_BUNDLE = "/tmp/alchemy-egress-ca-bundle.pem";

const SYSTEM_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt", // Debian, Ubuntu, Alpine
  "/etc/pki/tls/certs/ca-bundle.crt", // RHEL, Fedora
  "/etc/ssl/cert.pem",
];

/** Set when an egress is bound to the container. */
export const EGRESS_CA_SWITCH = "ALCHEMY_EGRESS_CA";

export const trustEgressCa: Effect.Effect<void, never, FileSystem.FileSystem> = Effect.gen(
  function* () {
    if (!process.env[EGRESS_CA_SWITCH]) return;
    const fs = yield* FileSystem.FileSystem;

    const readOr = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

    let current: string | undefined;
    const refresh = Effect.gen(function* () {
      const ca = yield* readOr(EGRESS_CA);
      if (current !== undefined && ca === current) return;
      let system = "";
      for (const path of SYSTEM_BUNDLES) {
        system = yield* readOr(path);
        if (system) break;
      }
      yield* fs.writeFileString(EGRESS_CA_BUNDLE, `${system}\n${ca}\n`);
      current = ca;
    }).pipe(Effect.ignore);

    // The bundle exists from the start (system roots only until the CA appears).
    yield* refresh;
    yield* Effect.sync(() => {
      // Read by each program at its own start.
      process.env.SSL_CERT_FILE = EGRESS_CA_BUNDLE; // OpenSSL, Go (gh), Python
      process.env.GIT_SSL_CAINFO = EGRESS_CA_BUNDLE; // git over HTTPS
      process.env.NODE_EXTRA_CA_CERTS = EGRESS_CA_BUNDLE; // Node, Bun
      process.env.REQUESTS_CA_BUNDLE = EGRESS_CA_BUNDLE; // Python requests
      process.env.CURL_CA_BUNDLE = EGRESS_CA_BUNDLE; // curl
    });
    yield* Effect.forkDetach(refresh.pipe(Effect.repeat(Schedule.spaced("1 second"))));
  },
);
