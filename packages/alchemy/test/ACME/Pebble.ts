/**
 * Pebble — Let's Encrypt's test CA — in Docker, with its `challtestsrv`
 * mock DNS so DNS-01 runs end to end without a real zone. One pair of
 * containers per suite (deterministic names + ports) so suites run
 * concurrently in the single test process.
 */
import * as ACME from "@/ACME";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { spawnSync } from "node:child_process";

/** The root that signs Pebble's own HTTPS certificate (`test/certs/pebble.minica.pem`). */
export const PEBBLE_ROOT = `-----BEGIN CERTIFICATE-----
MIIDPzCCAiegAwIBAgIIU0Xm9UFdQxUwDQYJKoZIhvcNAQELBQAwIDEeMBwGA1UE
AxMVbWluaWNhIHJvb3QgY2EgNTM0NWU2MCAXDTI1MDkwMzIzNDAwNVoYDzIxMjUw
OTAzMjM0MDA1WjAgMR4wHAYDVQQDExVtaW5pY2Egcm9vdCBjYSA1MzQ1ZTYwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC5WgZNoVJandj43kkLyU50vzCZ
alozvdRo3OFiKoDtmqKPNWRNO2hC9AUNxTDJco51Yc42u/WV3fPbbhSznTiOOVtn
Ajm6iq4I5nZYltGGZetGDOQWr78y2gWY+SG078MuOO2hyDIiKtVc3xiXYA+8Hluu
9F8KbqSS1h55yxZ9b87eKR+B0zu2ahzBCIHKmKWgc6N13l7aDxxY3D6uq8gtJRU0
toumyLbdzGcupVvjbjDP11nl07RESDWBLG1/g3ktJvqIa4BWgU2HMh4rND6y8OD3
Hy3H8MY6CElL+MOCbFJjWqhtOxeFyZZV9q3kYnk9CAuQJKMEGuN4GU6tzhW1AgMB
AAGjezB5MA4GA1UdDwEB/wQEAwIChDATBgNVHSUEDDAKBggrBgEFBQcDATASBgNV
HRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBSu8RGpErgYUoYnQuwCq+/ggTiEjDAf
BgNVHSMEGDAWgBSu8RGpErgYUoYnQuwCq+/ggTiEjDANBgkqhkiG9w0BAQsFAAOC
AQEAXDVYov1+f6EL7S41LhYQkEX/GyNNzsEvqxE9U0+3Iri5JfkcNOiA9O9L6Z+Y
bqcsXV93s3vi4r4WSWuc//wHyJYrVe5+tK4nlFpbJOvfBUtnoBDyKNxXzZCxFJVh
f9uc8UejRfQMFbDbhWY/x83y9BDufJHHq32OjCIN7gp2UR8rnfYvlz7Zg4qkJBsn
DG4dwd+pRTCFWJOVIG0JoNhK3ZmE7oJ1N4H38XkZ31NPcMksKxpsLLIS9+mosZtg
4olL7tMPJklx5ZaeMFaKRDq4Gdxkbw4+O4vRgNm3Z8AXWKknOdfgdpqLUPPhRcP4
v1lhy71EhBuXXwRQJry0lTdF+w==
-----END CERTIFICATE-----
`;

const PEBBLE_IMAGE = "ghcr.io/letsencrypt/pebble:latest";
const CHALLTESTSRV_IMAGE = "ghcr.io/letsencrypt/pebble-challtestsrv:latest";

export const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

const docker = (args: string[]) =>
  Effect.sync(() => {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  });

/** Solver descriptor type the in-test challtestsrv solver registers as. */
export const SOLVER_TYPE = "Test.ChallTestSrv";

export interface Pebble {
  readonly directoryUrl: string;
  readonly trustedRoot: string;
  readonly managementUrl: string;
  readonly ca: ACME.CertificateAuthority;
  readonly solver: ACME.DnsSolverDescriptor;
}

const names = (suite: string) => ({
  network: `alchemy-acme-${suite}`,
  challtestsrv: `alchemy-challtestsrv-${suite}`,
  pebble: `alchemy-pebble-${suite}`,
});

export const startPebble = (
  suite: string,
  ports: { readonly acme: number; readonly management: number },
): Effect.Effect<Pebble, Error> =>
  Effect.gen(function* () {
    const n = names(suite);
    yield* docker(["rm", "-f", n.challtestsrv, n.pebble]);
    yield* docker(["network", "create", n.network]);
    const chall = yield* docker([
      "run",
      "-d",
      "--name",
      n.challtestsrv,
      "--network",
      n.network,
      "-p",
      `${ports.management}:8055`,
      CHALLTESTSRV_IMAGE,
      "-defaultIPv4",
      "",
      "-defaultIPv6",
      "",
      "-http01",
      "",
      "-https01",
      "",
      "-tlsalpn01",
      "",
      "-doh",
      "",
    ]);
    if (chall.status !== 0) {
      return yield* Effect.fail(new Error(`challtestsrv: ${chall.stderr}`));
    }
    const pebble = yield* docker([
      "run",
      "-d",
      "--name",
      n.pebble,
      "--network",
      n.network,
      "-p",
      `${ports.acme}:14000`,
      "-e",
      "PEBBLE_VA_NOSLEEP=1",
      "-e",
      "PEBBLE_WFE_NONCEREJECT=0",
      PEBBLE_IMAGE,
      "-config",
      "test/config/pebble-config.json",
      "-dnsserver",
      `${n.challtestsrv}:8053`,
    ]);
    if (pebble.status !== 0) {
      return yield* Effect.fail(new Error(`pebble: ${pebble.stderr}`));
    }
    const directoryUrl = `https://localhost:${ports.acme}/dir`;
    const managementUrl = `http://localhost:${ports.management}`;
    yield* Effect.tryPromise({
      try: () =>
        fetch(directoryUrl, { tls: { ca: PEBBLE_ROOT } } as RequestInit),
      catch: (cause) => new Error(`pebble not ready: ${String(cause)}`),
    }).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.void
          : Effect.fail(new Error(`pebble answered ${response.status}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
    );
    return {
      directoryUrl,
      trustedRoot: PEBBLE_ROOT,
      managementUrl,
      ca: { directoryUrl, trustedRoot: PEBBLE_ROOT },
      solver: { type: SOLVER_TYPE, managementUrl },
    };
  });

export const stopPebble = (suite: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const n = names(suite);
    yield* docker(["rm", "-f", n.challtestsrv, n.pebble]);
    yield* docker(["network", "rm", n.network]);
  });

const management = (managementUrl: string, path: string, body: unknown) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${managementUrl}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`${path} answered ${response.status}`);
      }
    },
    catch: (cause) =>
      new ACME.DnsSolverError({
        message: `challtestsrv ${path} failed`,
        cause,
      }),
  });

const dotted = (fqdn: string) => (fqdn.endsWith(".") ? fqdn : `${fqdn}.`);

/** The in-test solver: TXT records live in challtestsrv, which Pebble resolves against. */
ACME.registerDnsSolver(SOLVER_TYPE, (descriptor) =>
  Effect.succeed({
    present: (record) =>
      management(String(descriptor.managementUrl), "/set-txt", {
        host: dotted(record.fqdn),
        value: record.value,
      }),
    cleanup: (record) =>
      management(String(descriptor.managementUrl), "/clear-txt", {
        host: dotted(record.fqdn),
      }),
    // Private DNS: public resolvers never see it.
    propagated: () => Effect.void,
  } satisfies ACME.DnsSolver),
);
