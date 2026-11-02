import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// A CDN distribution has no per-distribution fee and these tests send it no traffic, so
// the lifecycle runs ungated: under EUR 0.01 per run (price list v1.0.44, EUR 0.00005/MB).
const options = { tags: stackitTags("cdn", "distribution"), timeout: 900_000 } as const;

const ORIGIN = "https://www.stackit.de";
const OTHER_ORIGIN = "https://docs.stackit.cloud";

const getDistribution = (projectId: string, distributionId: string) =>
  cdn.getDistribution({ projectId, distributionId }).pipe(Effect.map((r) => r.distribution));

/** Bounded wait (about 10 minutes) until the distribution answers 404. */
const waitUntilGone = (projectId: string, distributionId: string) =>
  getDistribution(projectId, distributionId).pipe(
    Effect.map(() => "present" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (state) => state === "gone",
      times: 60,
    }),
  );

test.provider(
  "create, update and delete an HTTP distribution",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        backend: {
          type: "http",
          originUrl: `${ORIGIN}/ignored/path`,
          originRequestHeaders: { "x-origin": "alchemy" },
        },
        regions: ["EU"],
        defaultCacheDuration: "PT1H",
        cacheConfig: { queryStringVaryEnabled: true, queryStringVaryParameters: ["page"] },
        blockedCountries: ["KP"],
        blockedIps: ["203.0.113.7"],
        labels: { env: "test", keep: "yes" },
      } satisfies Stackit.CDN.DistributionProps;

      const created = yield* stack.deploy(Stackit.CDN.Distribution("Http", props));

      expect(created.distributionId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.status).toEqual("ACTIVE");
      expect(created.hostname.length).toBeGreaterThan(0);
      expect(created.url).toEqual(`https://${created.hostname}`);
      expect(created.labels).toEqual({ env: "test", keep: "yes" });
      expect(created.domains.map((domain) => domain.type)).toEqual(["managed"]);

      // Out of band: the settings and Alchemy's ownership labels landed.
      const fetched = yield* getDistribution(projectId, created.distributionId);
      expect(fetched.status).toEqual("ACTIVE");
      expect(fetched.config.backend).toMatchObject({ type: "http", originUrl: ORIGIN });
      expect(fetched.config.regions).toEqual(["EU"]);
      expect(fetched.config.blockedCountries).toEqual(["KP"]);
      expect(fetched.config.blockedIps).toEqual(["203.0.113.7"]);
      expect(fetched.config.labels).toMatchObject({
        env: "test",
        keep: "yes",
        "alchemy.id": "Http",
      });

      // Redeploying unchanged is a no-op, even though the origin path was dropped.
      const plan = yield* stack.plan(Stackit.CDN.Distribution("Http", props));
      expect(plan.resources.Http).toMatchObject({ action: "noop" });

      // Update in place: the regions grow, the origin and limits change, and a label and
      // the block lists are removed from the props.
      const updated = yield* stack.deploy(
        Stackit.CDN.Distribution("Http", {
          backend: { type: "http", originUrl: OTHER_ORIGIN },
          regions: ["EU", "US"],
          defaultCacheDuration: "PT2H",
          monthlyLimitBytes: 1_000_000_000,
          labels: { env: "prod" },
        }),
      );
      expect(updated.distributionId).toEqual(created.distributionId);
      expect(updated.hostname).toEqual(created.hostname);
      expect(updated.status).toEqual("ACTIVE");
      expect(updated.labels).toEqual({ env: "prod" });

      const refetched = yield* getDistribution(projectId, created.distributionId);
      expect(refetched.config.backend).toMatchObject({ type: "http", originUrl: OTHER_ORIGIN });
      expect([...refetched.config.regions].sort()).toEqual(["EU", "US"]);
      expect(refetched.config.monthlyLimitBytes).toEqual(1_000_000_000);
      expect(refetched.config.blockedCountries).toEqual([]);
      expect(refetched.config.blockedIps).toEqual([]);
      expect(refetched.config.cacheConfig.queryStringVaryEnabled).toEqual(false);
      expect(refetched.config.labels?.keep).toBeUndefined();
      expect(refetched.config.labels).toMatchObject({ env: "prod", "alchemy.id": "Http" });

      yield* stack.destroy();

      expect(yield* waitUntilGone(projectId, created.distributionId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "a bucket backend, switched from HTTP in place",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const backing = Effect.gen(function* () {
        const bucket = yield* Stackit.ObjectStorage.Bucket("CdnAssets", {});
        const group = yield* Stackit.ObjectStorage.CredentialsGroup("CdnReaders", {});
        const key = yield* Stackit.ObjectStorage.AccessKey("CdnKey", {
          credentialsGroupId: group.credentialsGroupId,
        });
        return { bucket, key };
      });

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          yield* backing;
          return yield* Stackit.CDN.Distribution("Origin", {
            backend: { type: "http", originUrl: ORIGIN },
          });
        }),
      );
      expect(first.config.backend.type).toEqual("http");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const { bucket, key } = yield* backing;
          const distribution = yield* Stackit.CDN.Distribution("Origin", {
            backend: {
              type: "bucket",
              bucketUrl: bucket.urlVirtualHostedStyle,
              region: bucket.region,
              credentials: {
                accessKeyId: key.accessKeyId,
                secretAccessKey: key.secretAccessKey,
              },
            },
          });
          return { distribution, bucketUrl: bucket.urlVirtualHostedStyle };
        }),
      );
      expect(second.distribution.distributionId).toEqual(first.distributionId);

      const fetched = yield* getDistribution(projectId, first.distributionId);
      expect(fetched.status).toEqual("ACTIVE");
      expect(fetched.config.backend).toMatchObject({ type: "bucket", bucketUrl: second.bucketUrl });
      // The API never echoes the credentials, so neither does the state.
      expect(JSON.stringify(fetched.config.backend)).not.toContain("secretAccessKey");

      yield* stack.destroy();

      expect(yield* waitUntilGone(projectId, first.distributionId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "redirects and a logged-only WAF, then both removed",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.CDN.Distribution("Guarded", {
          backend: { type: "http", originUrl: ORIGIN },
          tls: { enableTls11: false },
          redirects: {
            rules: [
              {
                targetUrl: "https://www.stackit.de/shop",
                statusCode: 301,
                matchers: [{ values: ["/shop/*"] }],
              },
            ],
          },
          waf: { mode: "LOG_ONLY", paranoiaLevel: "L1" },
        }),
      );
      const fetched = yield* getDistribution(projectId, created.distributionId);
      expect(fetched.config.redirects?.rules?.map((rule) => rule.statusCode)).toEqual([301]);
      expect(fetched.config.waf.mode).toEqual("LOG_ONLY");
      expect(fetched.config.tls.enableTls11).toEqual(false);

      yield* stack.deploy(
        Stackit.CDN.Distribution("Guarded", {
          backend: { type: "http", originUrl: ORIGIN },
        }),
      );
      const reset = yield* getDistribution(projectId, created.distributionId);
      expect(reset.config.redirects?.rules ?? []).toEqual([]);
      expect(reset.config.waf.mode).toEqual("DISABLED");

      yield* stack.destroy();

      expect(yield* waitUntilGone(projectId, created.distributionId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "a distribution deleted out of band is recreated with a new id",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.CDN.Distribution("Recreated", {
          backend: { type: "http", originUrl: ORIGIN },
        }),
      );
      yield* cdn.deleteDistribution({ projectId, distributionId: first.distributionId });
      expect(yield* waitUntilGone(projectId, first.distributionId)).toEqual("gone");

      // Any update reaches reconcile, which observes the distribution as missing.
      const second = yield* stack.deploy(
        Stackit.CDN.Distribution("Recreated", {
          backend: { type: "http", originUrl: OTHER_ORIGIN },
        }),
      );
      expect(second.distributionId).not.toEqual(first.distributionId);
      expect(second.status).toEqual("ACTIVE");

      yield* stack.destroy();

      expect(yield* waitUntilGone(projectId, second.distributionId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);
