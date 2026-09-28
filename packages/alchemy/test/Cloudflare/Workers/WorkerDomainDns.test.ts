/**
 * `Cloudflare.Worker` custom domains whose DNS lives outside Cloudflare,
 * served through Cloudflare for SaaS (`domain.dns` = a non-Cloudflare
 * adapter).
 *
 * The composition tests compile real stack programs (registration only —
 * no plan, no apply, no cloud calls) and assert on the declared resources.
 * The entitlement probe runs ungated; the full live lifecycle is gated
 * behind CLOUDFLARE_TEST_SAAS=1 + AWS_TEST_DOMAIN because Cloudflare for
 * SaaS is not provisioned on the test account (see the probe).
 */
import { AlchemyContext } from "@/AlchemyContext";
import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { customHostnameVerificationRecords } from "@/Cloudflare/Workers/WorkerDomainDns";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Output from "@/Output";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as customHostnames from "@distilled.cloud/cloudflare/custom-hostnames";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers()),
});

const main = pathe.resolve(import.meta.dirname, "fixtures", "saas-worker.ts");

const SAAS_ZONE_ID = "0123456789abcdef0123456789abcdef";
const HOSTED_ZONE_ID = "Z0000000000000";

interface CompiledResource {
  Type: string;
  Props: any;
}

/**
 * Compile a stack program (registration only) and return the declared
 * resources keyed by FQN. The stack gets no resource providers, only the
 * DNS adapter registrations `AWS.providers()` / `Cloudflare.providers()`
 * contribute.
 */
const compileStack = (
  build: Effect.Effect<any, any, any>,
): Effect.Effect<Record<string, CompiledResource>> =>
  Effect.scoped(
    (
      build.pipe(
        Effect.provide(
          Layer.mergeAll(AWS.Route53.AdapterLive, Cloudflare.DNS.AdapterLive),
        ),
      ) as Effect.Effect<any, any, never>
    ).pipe(
      Stack.make({
        name: "worker-domain-dns",
        providers: Layer.empty,
        state: inMemoryState(),
      } as any),
      Effect.map(
        (compiled: any) =>
          compiled.resources as Record<string, CompiledResource>,
      ),
    ),
  ).pipe(Effect.provideService(Stage, "test")) as Effect.Effect<
    Record<string, CompiledResource>
  >;

/** Evaluate a compiled prop against fake upstream attributes. */
const evaluate = (value: unknown, upstream: Record<string, unknown>) =>
  Output.evaluate(value, upstream).pipe(
    Effect.provide(inMemoryState()),
    Effect.orDie,
  );

const typesOf = (resources: Record<string, CompiledResource>) =>
  Object.values(resources).map((resource) => resource.Type);

/** The defect a failed compile died with. */
const compileDefect = (build: Effect.Effect<any, any, any>) =>
  compileStack(build).pipe(
    Effect.exit,
    Effect.map((exit) =>
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
    ),
  );

const route53Domain = {
  name: "app.example.com",
  aliases: ["www.example.com"],
  zoneId: SAAS_ZONE_ID,
  cnameTarget: "customers.saas.example",
  dns: AWS.Route53.Adapter({ hostedZoneId: HOSTED_ZONE_ID }),
};

describe(
  "Cloudflare.Worker domain.dns (composition)",
  {
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:workers",
      "provider:cloudflare:customhostname",
      "provider:aws",
      "local",
    ],
  },
  () => {
    test(
      "a Route 53 domain composes custom hostnames, Route 53 records and SaaS-zone routes",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          Cloudflare.Worker("Api", {
            main,
            routes: [{ pattern: "api.saas.example/*", zoneId: SAAS_ZONE_ID }],
            domain: route53Domain,
          }),
        );

        // Fake attributes of the deployed custom hostnames.
        const upstream = Object.fromEntries(
          ["app.example.com", "www.example.com"].map((hostname) => [
            `Api/CustomHostname-${hostname.replaceAll(".", "-")}`,
            {
              hostname,
              ownershipVerification: {
                name: `_cf-custom-hostname.${hostname}`,
                type: "txt",
                value: `ownership-${hostname}`,
              },
              validationRecords: [
                {
                  txtName: `_acme-challenge.${hostname}`,
                  txtValue: `dcv-${hostname}`,
                },
              ],
            },
          ]),
        );

        for (const [hostname, key] of [
          ["app.example.com", "app-example-com"],
          ["www.example.com", "www-example-com"],
        ] as const) {
          const customHostname = resources[`Api/CustomHostname-${key}`]!;
          expect(customHostname.Type).toBe(
            "Cloudflare.CustomHostname.CustomHostname",
          );
          expect(customHostname.Props.zoneId).toBe(SAAS_ZONE_ID);
          expect(customHostname.Props.hostname).toBe(hostname);
          expect(customHostname.Props.ssl).toEqual({
            method: "txt",
            type: "dv",
          });

          const verification = resources[`Api/Hostname-${key}-Verification`]!;
          expect(verification.Type).toBe("AWS.Route53.RecordList");
          expect(verification.Props.hostedZoneId).toBe(HOSTED_ZONE_ID);
          expect(yield* evaluate(verification.Props.records, upstream)).toEqual(
            [
              {
                name: `_cf-custom-hostname.${hostname}`,
                type: "TXT",
                value: `ownership-${hostname}`,
              },
              {
                name: `_acme-challenge.${hostname}`,
                type: "TXT",
                value: `dcv-${hostname}`,
              },
            ],
          );

          const cname = resources[`Api/Hostname-${key}`]!;
          expect(cname.Type).toBe("AWS.Route53.Record");
          expect(cname.Props).toMatchObject({
            hostedZoneId: HOSTED_ZONE_ID,
            name: hostname,
            type: "CNAME",
            records: ["customers.saas.example"],
          });
        }

        const worker = resources["Api"]!;
        expect(worker.Type).toBe("Cloudflare.Worker");
        expect("domain" in worker.Props).toBe(false);
        // Route patterns derive from the custom hostnames, so the Worker
        // (and its routes) deploy after them.
        expect(yield* evaluate(worker.Props.routes, upstream)).toEqual([
          { pattern: "api.saas.example/*", zoneId: SAAS_ZONE_ID },
          { pattern: "app.example.com/*", zoneId: SAAS_ZONE_ID },
          { pattern: "www.example.com/*", zoneId: SAAS_ZONE_ID },
        ]);
      }),
    );

    test(
      "without `dns` the native custom-domain props are untouched",
      Effect.gen(function* () {
        const domain = {
          name: "app.example.com",
          aliases: ["www.example.com"],
          redirects: ["old.example.com"],
          zoneId: SAAS_ZONE_ID,
        };
        const resources = yield* compileStack(
          Cloudflare.Worker("Api", { main, domain }),
        );
        expect(typesOf(resources)).not.toContain(
          "Cloudflare.CustomHostname.CustomHostname",
        );
        expect(resources["Api"]!.Props.domain).toBe(domain);
        expect(resources["Api"]!.Props.routes).toBeUndefined();
      }),
    );

    test(
      "a Cloudflare adapter keeps the native path and drops `dns`",
      Effect.gen(function* () {
        const resources = yield* compileStack(
          Cloudflare.Worker("Api", {
            main,
            domain: {
              name: "app.example.com",
              dns: Cloudflare.DNS.Adapter({ zone: "example.com" }),
            },
          }),
        );
        expect(typesOf(resources)).not.toContain(
          "Cloudflare.CustomHostname.CustomHostname",
        );
        expect(resources["Api"]!.Props.domain).toEqual({
          name: "app.example.com",
          zone: "example.com",
        });
      }),
    );

    test(
      "a bare Worker tag without its Layer still registers undefined props",
      Effect.gen(function* () {
        // `Plan.make` fails fast on `undefined` platform props (#1054); the
        // `transformProps` hook must not turn them into `{}`.
        // Bare-tag form (no props); the typed overloads require props.
        class Bare extends (Cloudflare.Worker as any)()("Bare") {}
        const resources = yield* compileStack(
          Bare as unknown as Effect.Effect<unknown>,
        );
        expect(resources["Bare"]!.Props).toBeUndefined();
      }),
    );

    test(
      "a Worker running locally under `alchemy dev` declares no SaaS resources",
      Effect.gen(function* () {
        const ctx = yield* AlchemyContext;
        const resources = yield* compileStack(
          Cloudflare.Worker("Api", { main, domain: route53Domain }),
        ).pipe(Effect.provideService(AlchemyContext, { ...ctx, dev: true }));
        expect(typesOf(resources)).not.toContain(
          "Cloudflare.CustomHostname.CustomHostname",
        );
        expect(resources["Api"]!.Props.domain).toBe(route53Domain);
      }),
    );

    test(
      "`redirects` with a non-Cloudflare `dns` dies with WorkerDomainDnsError",
      Effect.gen(function* () {
        const defect = yield* compileDefect(
          Cloudflare.Worker("Api", {
            main,
            domain: { ...route53Domain, redirects: ["old.example.com"] },
          }),
        );
        expect(defect).toBeInstanceOf(Cloudflare.WorkerDomainDnsError);
        expect((defect as Cloudflare.WorkerDomainDnsError).message).toContain(
          "domain.redirects",
        );
      }),
    );

    test(
      "`previews` with a non-Cloudflare `dns` dies with WorkerDomainDnsError",
      Effect.gen(function* () {
        const defect = yield* compileDefect(
          Cloudflare.Worker("Api", {
            main,
            domain: { ...route53Domain, previews: true },
          }),
        );
        expect(defect).toBeInstanceOf(Cloudflare.WorkerDomainDnsError);
        expect((defect as Cloudflare.WorkerDomainDnsError).message).toContain(
          "domain.previews",
        );
      }),
    );

    test(
      "a missing SaaS zone or cnameTarget dies with WorkerDomainDnsError",
      Effect.gen(function* () {
        const { zoneId: _zoneId, ...withoutZone } = route53Domain;
        const noZone = yield* compileDefect(
          Cloudflare.Worker("Api", { main, domain: withoutZone }),
        );
        expect(noZone).toBeInstanceOf(Cloudflare.WorkerDomainDnsError);
        expect((noZone as Cloudflare.WorkerDomainDnsError).message).toContain(
          "domain.zoneId",
        );

        const { cnameTarget: _cnameTarget, ...withoutTarget } = route53Domain;
        const noTarget = yield* compileDefect(
          Cloudflare.Worker("Api", { main, domain: withoutTarget }),
        );
        expect(noTarget).toBeInstanceOf(Cloudflare.WorkerDomainDnsError);
        expect((noTarget as Cloudflare.WorkerDomainDnsError).message).toContain(
          "domain.cnameTarget",
        );
      }),
    );

    test(
      "verification records collect the ownership and DCV TXT records",
      Effect.sync(() => {
        expect(
          customHostnameVerificationRecords(
            {
              name: "_cf-custom-hostname.app.example.com",
              type: "txt",
              value: "ownership-token",
            },
            [
              {
                cname: undefined,
                cnameTarget: undefined,
                emails: undefined,
                httpBody: undefined,
                httpUrl: undefined,
                status: "pending",
                txtName: "_acme-challenge.app.example.com",
                txtValue: "dcv-token",
              },
              {
                cname: undefined,
                cnameTarget: undefined,
                emails: undefined,
                httpBody: undefined,
                httpUrl: undefined,
                status: "pending",
                txtName: undefined,
                txtValue: undefined,
              },
            ],
          ),
        ).toEqual([
          {
            name: "_cf-custom-hostname.app.example.com",
            type: "TXT",
            value: "ownership-token",
          },
          {
            name: "_acme-challenge.app.example.com",
            type: "TXT",
            value: "dcv-token",
          },
        ]);
        expect(customHostnameVerificationRecords(undefined, undefined)).toEqual(
          [],
        );
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Live: entitlement probe (ungated) + full lifecycle (gated)
// ---------------------------------------------------------------------------

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const PROBE_HOSTNAME = "alchemy-worker-saas-probe.alchemy-saas-example.com";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// A freshly minted scoped token 403s intermittently while it propagates.
const forbiddenBlips = Schedule.exponential("500 millis");

const findCustomHostname = (zoneId: string, hostname: string) =>
  customHostnames.listCustomHostnames
    .items({ zoneId, hostname: { contain: hostname } })
    .pipe(
      Stream.filter((h) => h.hostname === hostname),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)[0]),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenBlips,
        times: 8,
      }),
    );

describe(
  "Cloudflare.Worker domain.dns (live)",
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:workers",
      "provider:cloudflare:customhostname",
      "live",
    ],
  },
  () => {
    // Cloudflare for SaaS needs a one-time dashboard enablement (payment on
    // file). On a zone without it, creating a custom hostname is rejected
    // with the typed `SaasQuotaNotAllocated` (code 1404). On an entitled
    // zone the probe hostname is created and removed again.
    test.provider(
      "custom hostname creation on the test zone is typed (entitlement probe)",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const zoneId = yield* resolveZoneId;
          const created = yield* customHostnames
            .createCustomHostname({
              zoneId,
              hostname: PROBE_HOSTNAME,
              ssl: { method: "txt", type: "dv" },
            })
            .pipe(
              Effect.map((hostname) => ({ entitled: true, hostname }) as const),
              Effect.catchTag("SaasQuotaNotAllocated", (error) =>
                Effect.succeed({ entitled: false, error } as const),
              ),
            );
          yield* Effect.logInfo(
            created.entitled
              ? `Cloudflare for SaaS is enabled on ${zoneName}`
              : `Cloudflare for SaaS is not enabled on ${zoneName}: ${created.error.message}`,
          );
          if (!created.entitled) {
            expect(created.error._tag).toBe("SaasQuotaNotAllocated");
          } else {
            yield* customHostnames
              .deleteCustomHostname({
                zoneId,
                customHostnameId: created.hostname.id,
              })
              .pipe(
                Effect.catchTag("CustomHostnameNotFound", () => Effect.void),
              );
            expect(yield* findCustomHostname(zoneId, PROBE_HOSTNAME)).toBe(
              undefined,
            );
          }
          yield* stack.destroy();
        }),
      { timeout: 60_000 },
    );

    test.provider(
      "a SaaS zone given by name is looked up in the account",
      () =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;
          const { zoneId: _zoneId, ...byName } = route53Domain;
          const resources = yield* compileStack(
            Cloudflare.Worker("Api", {
              main,
              domain: { ...byName, zoneName },
            }),
          );
          expect(
            resources["Api/CustomHostname-app-example-com"]!.Props.zoneId,
          ).toBe(zoneId);
          expect(resources["Api"]!.Props.routes[0].zoneId).toBe(zoneId);
        }),
      { timeout: 60_000 },
    );

    const awsTestDomain = process.env.AWS_TEST_DOMAIN;
    const SAAS_HOSTNAME = `alchemy-worker-saas.${awsTestDomain}`;
    const ORIGIN_NAME = `alchemy-worker-saas-origin.${zoneName}`;

    class NotServing extends Data.TaggedError("NotServing")<{
      readonly status: number;
    }> {}

    test.provider.skipIf(!process.env.CLOUDFLARE_TEST_SAAS || !awsTestDomain)(
      "a Worker on a Route 53 hostname serves through Cloudflare for SaaS",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const zoneId = yield* resolveZoneId;

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const origin = yield* Cloudflare.DNS.Record("SaasOrigin", {
                zoneId,
                name: ORIGIN_NAME,
                type: "AAAA",
                content: "100::",
                proxied: true,
              });
              const fallback = yield* Cloudflare.CustomHostname.FallbackOrigin(
                "SaasFallback",
                { zoneId, origin: origin.name },
              );
              const worker = yield* Cloudflare.Worker("SaasWorker", {
                main,
                domain: {
                  name: SAAS_HOSTNAME,
                  zoneId,
                  cnameTarget: fallback.origin,
                  dns: AWS.Route53.Adapter(),
                },
              });
              return { workerName: worker.workerName };
            }),
          );

          // Out-of-band: the custom hostname and the SaaS-zone route exist.
          const customHostname = yield* findCustomHostname(
            zoneId,
            SAAS_HOSTNAME,
          );
          expect(customHostname?.hostname).toBe(SAAS_HOSTNAME);
          const routes = yield* workers.listRoutes.items({ zoneId }).pipe(
            Stream.filter((route) => route.pattern === `${SAAS_HOSTNAME}/*`),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
          expect(routes.map((route) => route.script)).toEqual([
            deployed.workerName,
          ]);

          // Ownership + DCV complete asynchronously once Route 53 serves
          // the TXT records and the CNAME — bounded retry until it serves.
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get(`https://${SAAS_HOSTNAME}/`).pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? Effect.succeed(res)
                : Effect.fail(new NotServing({ status: res.status })),
            ),
            Effect.retry({
              schedule: Schedule.spaced("10 seconds"),
              times: 18,
            }),
          );
          expect(yield* response.text).toBe("saas-ok");

          yield* stack.destroy();
          expect(yield* findCustomHostname(zoneId, SAAS_HOSTNAME)).toBe(
            undefined,
          );
        }),
      { timeout: 300_000 },
    );
  },
);
