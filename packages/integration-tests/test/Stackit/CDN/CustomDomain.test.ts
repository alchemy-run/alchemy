import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CERT_A_PEM, CERT_B_PEM, FIXTURE_DOMAIN, KEY_A_PEM, KEY_B_PEM } from "./fixtures/certs.ts";

const { test } = makeStackitTest();

// No per-domain fee and no traffic: under EUR 0.01 per run. The fixed domain doesn't resolve,
// so the ungated test brings a certificate and skips the DNS check.
const options = { tags: stackitTags("cdn", "custom-domain"), timeout: 900_000 } as const;

const ORIGIN = "https://www.stackit.de";

/** Id of a zone already delegated to STACKIT. A managed certificate needs a domain that resolves. */
const delegatedZoneId = process.env.STACKIT_TEST_ZONE;

/** Bounded wait (about 10 minutes) until the domain answers 404. */
const waitUntilGone = (projectId: string, distributionId: string, domain: string) =>
  cdn.getCustomDomain({ projectId, distributionId, domain }).pipe(
    Effect.map(() => "present" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (state) => state === "gone",
      times: 60,
    }),
  );

const withDomain = (certificate: Stackit.CDN.CustomDomainCustomCertificate) =>
  Effect.gen(function* () {
    const distribution = yield* Stackit.CDN.Distribution("Host", {
      backend: { type: "http", originUrl: ORIGIN },
    });
    const domain = yield* Stackit.CDN.CustomDomain("Domain", {
      distributionId: distribution.distributionId,
      domain: FIXTURE_DOMAIN,
      certificate,
    });
    return { distribution, domain };
  });

const certificateA = {
  type: "custom",
  certificate: CERT_A_PEM,
  privateKey: Redacted.make(KEY_A_PEM),
  skipDnsCheck: true,
} as const;

test.provider(
  "a custom certificate: create, rotate and delete",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { distribution, domain } = yield* stack.deploy(withDomain(certificateA));
      expect(domain.domain).toEqual(FIXTURE_DOMAIN);
      expect(domain.distributionId).toEqual(distribution.distributionId);
      expect(domain.status).toEqual("ACTIVE");
      expect(domain.certificateType).toEqual("custom");
      expect(domain.skipDnsCheck).toEqual(true);
      expect(domain.certificateVersion).toEqual(1);

      // Out of band: the domain is on the distribution, and reports no key material.
      const live = yield* cdn.getCustomDomain({
        projectId,
        distributionId: distribution.distributionId,
        domain: FIXTURE_DOMAIN,
      });
      expect(live.customDomain.status).toEqual("ACTIVE");
      expect(JSON.stringify(live)).not.toContain("PRIVATE KEY");
      const { distribution: host } = yield* cdn.getDistribution({
        projectId,
        distributionId: distribution.distributionId,
      });
      expect(
        host.domains.filter((item) => item.type === "custom").map((item) => item.name),
      ).toEqual([FIXTURE_DOMAIN]);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(withDomain(certificateA));
      expect(plan.resources.Domain).toMatchObject({ action: "noop" });

      // A new pair updates in place and raises the version.
      const rotated = yield* stack.deploy(
        withDomain({
          type: "custom",
          certificate: CERT_B_PEM,
          privateKey: Redacted.make(KEY_B_PEM),
          skipDnsCheck: true,
        }),
      );
      expect(rotated.domain.domain).toEqual(FIXTURE_DOMAIN);
      expect(rotated.domain.certificateVersion).toEqual(2);

      yield* stack.destroy();

      expect(yield* waitUntilGone(projectId, distribution.distributionId, FIXTURE_DOMAIN)).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  options,
);

test.provider(
  "moving the domain to another distribution replaces it, old one first",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const hosts = Effect.gen(function* () {
        const first = yield* Stackit.CDN.Distribution("First", {
          backend: { type: "http", originUrl: ORIGIN },
        });
        const second = yield* Stackit.CDN.Distribution("Second", {
          backend: { type: "http", originUrl: ORIGIN },
        });
        return { first, second };
      });

      const before = yield* stack.deploy(
        Effect.gen(function* () {
          const { first, second } = yield* hosts;
          const domain = yield* Stackit.CDN.CustomDomain("Moved", {
            distributionId: first.distributionId,
            domain: FIXTURE_DOMAIN,
            certificate: certificateA,
          });
          return { first, second, domain };
        }),
      );
      expect(before.domain.distributionId).toEqual(before.first.distributionId);

      const after = yield* stack.deploy(
        Effect.gen(function* () {
          const { first, second } = yield* hosts;
          const domain = yield* Stackit.CDN.CustomDomain("Moved", {
            distributionId: second.distributionId,
            domain: FIXTURE_DOMAIN,
            certificate: certificateA,
          });
          return { first, second, domain };
        }),
      );
      expect(after.domain.distributionId).toEqual(before.second.distributionId);
      expect(yield* waitUntilGone(projectId, before.first.distributionId, FIXTURE_DOMAIN)).toEqual(
        "gone",
      );

      yield* stack.destroy();

      expect(yield* waitUntilGone(projectId, before.second.distributionId, FIXTURE_DOMAIN)).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  options,
);

// STACKIT_TEST_ZONE holds the id of a zone already delegated to STACKIT: it costs nothing extra,
// but a managed certificate needs the CNAME to resolve publicly and Let's Encrypt to issue.
test.provider.skipIf(delegatedZoneId === undefined)(
  "a managed certificate on a delegated zone",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { domain, distributionId } = yield* stack.deploy(
        Effect.gen(function* () {
          const distribution = yield* Stackit.CDN.Distribution("Managed", {
            backend: { type: "http", originUrl: ORIGIN },
          });
          const record = yield* Stackit.DNS.RecordSet("Cname", {
            zoneId: delegatedZoneId!,
            name: "cdn-managed",
            type: "CNAME",
            ttl: 60,
            records: [Output.interpolate`${distribution.hostname}.`],
          });
          const custom = yield* Stackit.CDN.CustomDomain("ManagedDomain", {
            distributionId: distribution.distributionId,
            domain: record.fqdn,
          });
          return { domain: custom, distributionId: distribution.distributionId };
        }),
      );
      expect(domain.status).toEqual("ACTIVE");
      expect(domain.certificateType).toEqual("managed");
      expect(domain.certificateVersion).toBeUndefined();

      yield* stack.destroy();

      expect(yield* waitUntilGone(projectId, distributionId, domain.domain)).toEqual("gone");
    }).pipe(logLevel),
  options,
);
