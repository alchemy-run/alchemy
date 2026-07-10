import * as AWS from "@/AWS";
import { Subnet } from "@/AWS/EC2";
import { Listener, ListenerCertificate, LoadBalancer } from "@/AWS/ELBv2";
import * as Test from "@/Test/Vitest";
import * as acm from "@distilled.cloud/aws/acm";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { getDefaultVpc } from "../DefaultVpc.ts";
import {
  DEFAULT_CERT_PEM,
  DEFAULT_KEY_PEM,
  SNI_CERT_PEM,
  SNI_KEY_PEM,
} from "./fixtures/certs.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Find an existing imported test certificate by domain (a previous run may
// have left one behind) or import the checked-in self-signed fixture. Import
// without a CertificateArn mints a new certificate each call, so reuse keeps
// repeated runs deterministic and leak-free.
const ensureImportedCert = Effect.fn(function* (
  domainName: string,
  certPem: string,
  keyPem: string,
) {
  const pages = yield* acm.listCertificates
    .pages({ CertificateStatuses: ["ISSUED"] })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.CertificateSummaryList ?? []),
      ),
    );
  const existing = pages.find((c) => c.DomainName === domainName);
  if (existing?.CertificateArn) {
    return existing.CertificateArn;
  }
  const encode = (pem: string) =>
    Effect.sync(() => new TextEncoder().encode(pem));
  const imported = yield* acm.importCertificate({
    Certificate: yield* encode(certPem),
    PrivateKey: yield* encode(keyPem),
  });
  expect(imported.CertificateArn).toBeTruthy();
  return imported.CertificateArn!;
});

// Deleting right after the listener detaches can race eventual consistency;
// retry briefly, then leave the certificate behind (the next run reuses it).
const deleteCertBestEffort = Effect.fn(function* (certificateArn: string) {
  yield* acm.deleteCertificate({ CertificateArn: certificateArn }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ResourceInUseException",
      schedule: Schedule.spaced("3 seconds").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
    Effect.catchTag("ResourceInUseException", () =>
      Effect.logWarning(
        `certificate ${certificateArn} still in use; leaving it for reuse`,
      ),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});

// Attach an extra SNI certificate to an HTTPS listener via the standalone
// ListenerCertificate resource, verify out-of-band, then remove the resource
// (stage 2) and assert the certificate is detached while the listener (and
// its default certificate) survive.
test.provider(
  "listener certificate: SNI attach and detach",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const defaultCertArn = yield* ensureImportedCert(
        "default.elbv2-test.alchemy.internal",
        DEFAULT_CERT_PEM,
        DEFAULT_KEY_PEM,
      );
      const sniCertArn = yield* ensureImportedCert(
        "sni.elbv2-test.alchemy.internal",
        SNI_CERT_PEM,
        SNI_KEY_PEM,
      );

      const azResult = yield* EC2.describeAvailabilityZones({});
      const azs =
        azResult.AvailabilityZones?.filter(
          (az) => az.State === "available",
        ).flatMap((az) => (az.ZoneName ? [az.ZoneName] : [])) ?? [];
      const [az1, az2] = azs;
      expect(az1).toBeTruthy();
      expect(az2).toBeTruthy();

      const defaultVpc = yield* getDefaultVpc;

      const stage = (attachSniCert: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const subnet1 = yield* Subnet("LcSubnet1", {
              vpcId: defaultVpc.vpcId,
              cidrBlock: defaultVpc.subnetCidrBlock(230),
              availabilityZone: az1,
            });
            const subnet2 = yield* Subnet("LcSubnet2", {
              vpcId: defaultVpc.vpcId,
              cidrBlock: defaultVpc.subnetCidrBlock(231),
              availabilityZone: az2,
            });
            const lb = yield* LoadBalancer("LcLb", {
              subnets: [subnet1.subnetId, subnet2.subnetId],
              scheme: "internal",
              type: "application",
            });
            const listener = yield* Listener("LcListener", {
              loadBalancerArn: lb.loadBalancerArn,
              port: 443,
              protocol: "HTTPS",
              certificateArn: defaultCertArn,
              defaultActions: [
                {
                  type: "fixedResponse",
                  statusCode: "200",
                  contentType: "text/plain",
                  messageBody: "ok",
                },
              ],
            });
            if (attachSniCert) {
              yield* ListenerCertificate("LcSniCert", {
                listenerArn: listener.listenerArn,
                certificateArn: sniCertArn,
              });
            }
            return { listenerArn: listener.listenerArn };
          }),
        );

      // STAGE 1: SNI certificate attached.
      const s1 = yield* stage(true);

      const describeCerts = elbv2
        .describeListenerCertificates({ ListenerArn: s1.listenerArn })
        .pipe(Effect.map((r) => r.Certificates ?? []));

      let certs = yield* describeCerts;
      expect(
        certs.some((c) => c.IsDefault && c.CertificateArn === defaultCertArn),
      ).toBe(true);
      expect(
        certs.some((c) => !c.IsDefault && c.CertificateArn === sniCertArn),
      ).toBe(true);

      // STAGE 2: remove the ListenerCertificate resource — the SNI cert is
      // detached, the listener and its default certificate survive (and the
      // Listener's reconcile must NOT have pruned anything on its own).
      yield* stage(false);

      certs = yield* describeCerts;
      expect(
        certs.some((c) => c.IsDefault && c.CertificateArn === defaultCertArn),
      ).toBe(true);
      expect(
        certs.some((c) => !c.IsDefault && c.CertificateArn === sniCertArn),
      ).toBe(false);

      yield* stack.destroy();

      const after = yield* elbv2
        .describeListenerCertificates({ ListenerArn: s1.listenerArn })
        .pipe(
          Effect.map((r) => r.Certificates?.length ?? 0),
          Effect.catchTag("ListenerNotFoundException", () => Effect.succeed(0)),
        );
      expect(after).toBe(0);

      // Cleanup — best-effort delete of the imported certificates.
      yield* deleteCertBestEffort(sniCertArn);
      yield* deleteCertBestEffort(defaultCertArn);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
