import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { TrustStore } from "@/AWS/ELBv2";
import * as Test from "@/Test/Vitest";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A self-signed CA certificate generated once and checked in (never created at
// test time, per the fixture convention).
const CA_BUNDLE_PEM = `-----BEGIN CERTIFICATE-----
MIICsDCCAZgCCQCOyVdAEfzVrzANBgkqhkiG9w0BAQsFADAaMRgwFgYDVQQDDA9h
bGNoZW15LXRlc3QtY2EwHhcNMjYwNjE3MDUzMDIyWhcNMzYwNjE0MDUzMDIyWjAa
MRgwFgYDVQQDDA9hbGNoZW15LXRlc3QtY2EwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQDXVvlLwylBgYwGMOc8Vh4X7P12dKL7mL0sT8T0Kr5NnAe5yG7l
tjUYa2LODESPr8Kmc0lg/8uLNnkA7siUeo6FGDF61Cv320SlEsgKWS0tLiYIdbll
JEipjgx+Xc9LKrWOmvlWYZhe5SYh4xGhP/vuqbX8IO855xkG2BgpNGkjM064nMLH
6r6AVLrfxZwonGYQmGNQ4i7RKnOc+kAilMplGLT3czFyz/VvzTks02eIspoYMcPK
k9JUlJHGmX5b8IgBxDTk4zFCFsr3zt9gj006Z/t/WLqYTb1WnY/0G513XivaM2QB
4G53pkpLcIhDHgFOYCgaMACV2z/QFdv7pNgnAgMBAAEwDQYJKoZIhvcNAQELBQAD
ggEBAMIw2i+MaKWCmh78qTgsa4SGBa1oQCFPHxGYeXaMBHZZNhxiyEtnBlqRIRAf
a8mChI++HPkSwcfnbB+MK96yzW1M/8MsNjkpsWdSRppjVmuC9AotpLCQ4wTIlpvk
LnQ7QyWfx+dK68ptK1UTtevMLinUdXe1YBJW+30wtzI+QL/EZ/+CSNZfW8/FNZlr
VwNbYejvuLYlNwq1UgrA+XWWg7P7DrKOXlQvcjVJjTjpr8MZGuD7uVgKqj86EXe3
2WCnIRCSyPzdYbMoUoEAkb9F4kntGLIPWM5pPMyOrGR0nWJaeUnVDzDZ40O0Yay6
9x8oFGZ/O2NaUM5uQsFpFFoI+ks=
-----END CERTIFICATE-----
`;

// Fast unconditional probe: createTrustStore against a non-existent bundle
// must surface a typed error (not an untyped catch-all). Proves both the
// resource wiring and the distilled typed-error path.
test.provider(
  "trust store create with missing bundle returns a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* elbv2
        .createTrustStore({
          Name: `alchemy-mtls-probe-${stack.name.replace(/[^a-zA-Z0-9]/g, "")}`.slice(
            0,
            32,
          ),
          CaCertificatesBundleS3Bucket: "alchemy-no-such-bucket-elbv2-probe",
          CaCertificatesBundleS3Key: "missing.pem",
        })
        .pipe(Effect.flip);

      // AWS rejects a missing/inaccessible bundle with one of these typed tags.
      expect(
        [
          "CaCertificatesBundleNotFoundException",
          "InvalidCaCertificatesBundleException",
        ].includes(result._tag),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Full mTLS-verify lifecycle: upload a CA bundle to a stack-owned bucket, create
// an ACTIVE trust store, then destroy. Gated — requires an account that can
// create trust stores and an S3 bucket.
test.provider.skipIf(!process.env.ELBV2_TEST_MTLS)(
  "trust store full lifecycle from an uploaded CA bundle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("TsBucket", { forceDestroy: true });
          return { bucketName: bucket.bucketName };
        }),
      );

      const key = "ca-bundle.pem";
      yield* s3.putObject({
        Bucket: deployed.bucketName,
        Key: key,
        Body: CA_BUNDLE_PEM,
        ContentType: "application/x-pem-file",
      });

      const ts = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("TsBucket", { forceDestroy: true });
          const trustStore = yield* TrustStore("TsStore", {
            caCertificatesBundleS3Bucket: bucket.bucketName,
            caCertificatesBundleS3Key: key,
          });
          return { trustStore };
        }),
      );

      expect(ts.trustStore.status).toBe("ACTIVE");
      expect(ts.trustStore.numberOfCaCertificates).toBeGreaterThanOrEqual(1);

      const observed = yield* elbv2
        .describeTrustStores({
          TrustStoreArns: [ts.trustStore.trustStoreArn],
        })
        .pipe(Effect.map((r) => r.TrustStores?.[0]));
      expect(observed?.Status).toBe("ACTIVE");

      yield* stack.destroy();

      const after = yield* elbv2
        .describeTrustStores({
          TrustStoreArns: [ts.trustStore.trustStoreArn],
        })
        .pipe(
          Effect.map((r) => r.TrustStores?.length ?? 0),
          Effect.catchTag("TrustStoreNotFoundException", () =>
            Effect.succeed(0),
          ),
        );
      expect(after).toBe(0);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
