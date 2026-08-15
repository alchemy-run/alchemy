import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as certs from "@distilled.cloud/vercel/certs";
import * as domains from "@distilled.cloud/vercel/domains";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

// Checked-in fixture (generated once with `openssl req -x509 -newkey
// rsa:2048 -days 3650 -nodes -subj "/CN=alchemy-vercel-test.example"`) —
// never generated at test time. Used only to exercise the typed
// entitlement rejection on uploadCert; the key secures nothing.
const FIXTURE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIICyDCCAbACCQCUO0vwUYEX/DANBgkqhkiG9w0BAQsFADAmMSQwIgYDVQQDDBth
bGNoZW15LXZlcmNlbC10ZXN0LmV4YW1wbGUwHhcNMjYwODE0MDE1MzUwWhcNMzYw
ODExMDE1MzUwWjAmMSQwIgYDVQQDDBthbGNoZW15LXZlcmNlbC10ZXN0LmV4YW1w
bGUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDEFCprKhFDZ1vR2b54
ILB3G2CFBy7SLoXEOQZTHgj9SNvvleHoHRJcewThGfe+J8tOlngL76cCoFCyOeB1
Iz4a1LgU44RzpfUWx7wvf8FV2d/4QcI2Czo2Pmh0c5cq9n0rq9myvjb8RFMHqsAA
zt5rpIjHL10PK9+4nUd0tZrF71twOEqKdHyCdMHzZnt4QQxwF4G/lJztXacbDPvU
Zg2pup0McaGSGMHDm6u0HpS3Cm2zLEgDzRfc/6C2of6KiCPFjpl2hGZosrXojoOx
7QPDeTKHJS8A0IXt1Vddu+hGNeJj3H8yzmdDMZKgUeGsfEIlWlw7+EDjlGvt+/vK
lW1pAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAJtHvR5XR2IzOeu7gW63YMnMT5xm
eV25dZaQNzSb6LqOf41PC45Ibew1ao2zPZHnPkWxj3iLNsm0Lv2MciAHgDzmyTBE
AX72USIFIq7e/CwBTGgGsgeGFPxySJD3h8RBxOG7bhcJEfVUB29nIuJPVwgkrtSu
sAo4uLm3EUNH7M3XHiSea9UnfbYI9uKvMjJYzoucWucJxLv6EB8HV1vODZRn3V9h
EFxAHyG/QelwT3yepNWHF29rbbte9HTV7oUB6XcaMqhDz8Nh6wCe5p73gxBU2zKL
fM28jl++ouiSMM7vVt/nheYzZ3ejYrcPi3GslScl9no8m5voUXuu0rvIVKk=
-----END CERTIFICATE-----`;

const FIXTURE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDEFCprKhFDZ1vR
2b54ILB3G2CFBy7SLoXEOQZTHgj9SNvvleHoHRJcewThGfe+J8tOlngL76cCoFCy
OeB1Iz4a1LgU44RzpfUWx7wvf8FV2d/4QcI2Czo2Pmh0c5cq9n0rq9myvjb8RFMH
qsAAzt5rpIjHL10PK9+4nUd0tZrF71twOEqKdHyCdMHzZnt4QQxwF4G/lJztXacb
DPvUZg2pup0McaGSGMHDm6u0HpS3Cm2zLEgDzRfc/6C2of6KiCPFjpl2hGZosrXo
joOx7QPDeTKHJS8A0IXt1Vddu+hGNeJj3H8yzmdDMZKgUeGsfEIlWlw7+EDjlGvt
+/vKlW1pAgMBAAECggEAFlZdxruSH+WkdjGiGzlOISODSWRaFyOppYMBj3J6f7BP
LeobREAbmWGCWsqEiKsr5BYMMv/oPMpapxMk2PNc3d2h4u9QZYRgeWnjrF2XftpF
Q5jqMRHyXb+aUrngXMqb09/N+yjkRrTZ6KOxH+ZxPD4QPvDMXzAWWofAXjFaInZA
ycoGTV+0eSUOGiY6r+1E3nmWpglYpNCwiWy3TY2AKuRWjorpLg5Ro+3bLZc5AASE
Jh1uXJ/lbyQIwvoipaME8J20flVHPMX+/YnOmQO5LelPrVNRVJaghHC5UVwPEHKM
3yzdiNUL4L99B31OwDyiVbnuG10B54YHxEgWytZpyQKBgQD7BWa0tkKdwdRdrgIp
Pklhoyoy9RYAdQU1lYr3f4SllgLTBClQXXE0pP1QXXUiwnMABMj14ZAjv7j+WRqa
AlHN93VIHL9Ns25F2MSYmzxy7IdK8SZ7ek0OG48NpVJIsCw+9df9V4W7brMg2wsh
IipgYfBO4NHNcRU5qJ3FOPdcxwKBgQDH98lIxLIvGKCxGu5W0NbtrCGYC3AMqE3W
DWK4eb9m1EQvs+G8Fb5CxeWAmFhvTpT0NW57jXwK+9QLZDf+J1LX+k8ugw+5PxDg
IiPjLI4QiyZhbSg8nX0Na8byn7785xwKX8MydEKuPMDnWPsaUu4miMV4xdGTuqSG
4o1+rj3UTwKBgDj/W/fSnsO1fGQdG86DnyP1aaKSdgF6kMk/AIP8R4FV06RYgI0H
+qmKgR5bajqPTo+FhqAWLKWBZh8S2nB38F1FQDM0m9en03U2qEVCknJB9OJ2aVeG
SLLYXR4rGMj6f8F4DyguVGZf13qxYhCO8nJaKreuYtU0RS6Hc/ORYNGHAoGBAJOB
VWonJeUVvptF6WAC5zgkzBcTANFlaR0nfJXlwOmCVNX3U+FhDJrGzfdg6YMZrUjD
DT94a3LStmS8xYzlxvdoPfZqWTPlsHYU2PIfkJ/ldSdS1OZ5qaA3y2Z3rfNyKz3/
y8Yw+mr6h7Vf7sJJQEEOjNP84A6gE/MntQYoU5WDAoGAMUbX10JS6OcoEZxasuc+
BgAwPQ7tkJe/7i7Lb+pADdiUT12yv8l7VaWbAP+Cb6wNyLrAceKP0WMreMQDQ3nY
OyygTGQHj7MMsD613+XPbiuBBfPHDFoGGOg+doA0CAAvbj/lhISnRcUyB9RuWt3G
Pc3wJwE5ts33pfgbSEURp9w=
-----END PRIVATE KEY-----`;

// ─────────────────────────────────────────────────────────────────────────────
// Ungated probes — pin the typed entitlement/pretest rejections forever, at
// near-zero cost (no cert is ever created on the account).
// ─────────────────────────────────────────────────────────────────────────────

test.provider(
  "issueCert for a domain not resolving to Vercel fails with the typed DomainPretestFailed (HTTP 449)",
  (_stack) =>
    Effect.gen(function* () {
      const team = yield* teamScope;
      const NAME = "alchemy-vercel-test-cert.example";
      // Ensure the domain exists on the team (idempotent upsert) so the
      // pretest actually runs.
      yield* domains.createOrTransferDomain({ name: NAME, ...team });
      const error = yield* certs
        .issueCert({ cns: [NAME], ...team })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("DomainPretestFailed");
      yield* domains
        .deleteDomain({ domain: NAME, ...team })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider(
  "uploadCert without an Enterprise plan fails with the typed PaymentRequired",
  (_stack) =>
    Effect.gen(function* () {
      const team = yield* teamScope;
      const error = yield* certs
        .uploadCert({
          ...team,
          ca: FIXTURE_CERT_PEM,
          key: FIXTURE_KEY_PEM,
          cert: FIXTURE_CERT_PEM,
          skipValidation: true,
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("PaymentRequired");
    }).pipe(logLevel),
  { timeout: 60_000 },
);

// ─────────────────────────────────────────────────────────────────────────────
// Full lifecycle — needs a domain that actually resolves to Vercel (issuance
// runs an HTTP pretest against the live edge), which the testing team does
// not have. Entitled environments run it with:
//   VERCEL_TEST_CERTS=1 VERCEL_TEST_CERT_CNS=resolving.example.com
// ─────────────────────────────────────────────────────────────────────────────

test.provider.skipIf(!process.env.VERCEL_TEST_CERTS)(
  "cert lifecycle: issue, observe, destroy (VERCEL_TEST_CERTS=1)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const cns = (process.env.VERCEL_TEST_CERT_CNS ?? "")
        .split(",")
        .filter((s) => s.length > 0);
      expect(cns.length).toBeGreaterThan(0);

      const created = yield* stack.deploy(Vercel.Cert("Cert", { cns }));
      expect(created.certId.length).toBeGreaterThan(0);
      expect(created.expiresAt).toBeGreaterThan(created.createdAt);

      const team = yield* teamScope;
      const observed = yield* certs.getCertById({
        id: created.certId,
        ...team,
      });
      expect(observed.id).toEqual(created.certId);

      yield* stack.destroy();
      const gone = yield* certs
        .getCertById({ id: created.certId, ...team })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (s) => s === "gone",
            times: 10,
          }),
        );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
