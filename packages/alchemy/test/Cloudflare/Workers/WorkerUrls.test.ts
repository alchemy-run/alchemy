import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { WorkerDomainConfigError } from "@/Cloudflare/Workers/WorkerProvider.ts";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const script = (marker: string) =>
  `export default { fetch() { return new Response("${marker}"); } };`;

class RedirectNotReady extends Data.TaggedError("RedirectNotReady")<{
  url: string;
  detail: string;
}> {}

/**
 * Fetch `from` without following redirects and assert a 301 whose
 * `location` matches `expectedLocation` exactly (path + query preserved).
 * Retried through DNS/certificate propagation on a freshly attached
 * custom domain.
 */
const expectRedirect = Effect.fn(function* (
  from: string,
  expectedLocation: string,
) {
  const location = yield* Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(from, { redirect: "manual", signal });
      if (res.status !== 301) {
        throw new Error(`expected 301, got ${res.status}`);
      }
      return res.headers.get("location") ?? "";
    },
    catch: (cause) =>
      new RedirectNotReady({ url: from, detail: String(cause) }),
  }).pipe(
    Effect.flatMap((location) =>
      location === expectedLocation
        ? Effect.succeed(location)
        : Effect.fail(
            new RedirectNotReady({
              url: from,
              detail: `location was '${location}', expected '${expectedLocation}'`,
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "RedirectNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 24,
    }),
  );
  expect(location).toEqual(expectedLocation);
});

/** Our redirect rules in the zone's dynamic-redirect phase entrypoint. */
const listWorkerRedirectRules = Effect.fn(function* (
  zoneId: string,
  scriptName: string,
) {
  const entrypoint = yield* rulesets
    .getPhasForZone({ zoneId, rulesetPhase: "http_request_dynamic_redirect" })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return (entrypoint?.rules ?? []).flatMap((rule) =>
    (rule.description ?? "").startsWith(
      `alchemy:worker:${scriptName}:redirect:`,
    )
      ? [rule.description as string]
      : [],
  );
});

describe.concurrent("Cloudflare.Worker urls & domain", () => {
  test.provider(
    "rejects a hostname playing more than one role",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const error = yield* stack
          .deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("OverlapWorker", {
                script: script("overlap"),
                domain: {
                  name: "app.example.com",
                  aliases: ["app.example.com"],
                },
              });
            }),
          )
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkerDomainConfigError);
        expect(String(error)).toContain("one role");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  const customDomainZone = process.env.CLOUDFLARE_TEST_WORKER_DOMAIN_ZONE_NAME;
  test.provider.skipIf(!customDomainZone)(
    "redirect hostnames 301 to the canonical name and stay out of urls",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const suffix = process.env.PULL_REQUEST ?? process.env.USER ?? "local";
        const mainHost = `alchemy-redirect-main-${suffix}.${customDomainZone}`;
        const oldHost = `alchemy-redirect-old-${suffix}.${customDomainZone}`;

        yield* stack.destroy();

        const deploy = (domain: { name: string; redirects?: string[] }) =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("RedirectWorker", {
                script: script("redirect-target"),
                domain,
              });
            }),
          );

        const worker = yield* deploy({
          name: mainHost,
          redirects: [oldHost],
        });

        // The redirect hostname is part of the domain config but serves
        // nothing — it must not appear in `urls`.
        expect(worker.domain).toEqual({
          name: mainHost,
          aliases: [],
          redirects: [oldHost],
        });
        expect(worker.url).toEqual(`https://${mainHost}`);
        expect(worker.urls.some((u) => u.includes(oldHost))).toBe(false);
        // workers.dev stays on by default and ranks after the domain.
        expect(worker.urls[worker.urls.length - 1]).toMatch(/\.workers\.dev$/);

        // Our tagged rule exists in the zone's shared entrypoint.
        const zone = yield* findZoneByName({
          accountId,
          name: customDomainZone!,
        });
        expect(zone).toBeDefined();
        expect(
          yield* listWorkerRedirectRules(zone!.id, worker.workerName),
        ).toEqual([`alchemy:worker:${worker.workerName}:redirect:${oldHost}`]);

        // The canonical domain serves the Worker; the redirect host 301s
        // with path and query preserved — and never invokes the Worker.
        // First-ever attachment of a hostname waits on edge-certificate
        // issuance, which can take a few minutes — hence the long budget.
        yield* expectUrlContains(worker.url!, "redirect-target", {
          label: "canonical domain serves the worker",
          timeout: "240 seconds",
        });
        yield* expectRedirect(
          `https://${oldHost}/hello?x=1`,
          `https://${mainHost}/hello?x=1`,
        );

        // Removing the redirect cleans our rule and detaches nothing else.
        const updated = yield* deploy({ name: mainHost });
        expect(updated.domain).toEqual({
          name: mainHost,
          aliases: [],
          redirects: [],
        });
        expect(
          yield* listWorkerRedirectRules(zone!.id, updated.workerName),
        ).toEqual([]);

        // Re-add, then destroy — teardown must remove the rule too.
        const readded = yield* deploy({
          name: mainHost,
          redirects: [oldHost],
        });
        expect(
          yield* listWorkerRedirectRules(zone!.id, readded.workerName),
        ).toHaveLength(1);
        yield* stack.destroy();
        expect(
          yield* listWorkerRedirectRules(zone!.id, readded.workerName),
        ).toEqual([]);
        yield* waitForWorkerToBeDeleted(readded.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 540_000 },
  );

  test.provider.skipIf(!customDomainZone)(
    "domain string shorthand resolves to { name }",
    (stack) =>
      Effect.gen(function* () {
        const suffix = process.env.PULL_REQUEST ?? process.env.USER ?? "local";
        const host = `alchemy-shorthand-${suffix}.${customDomainZone}`;

        yield* stack.destroy();

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("ShorthandWorker", {
              script: script("shorthand"),
              domain: host,
              workersDev: false,
            });
          }),
        );

        expect(worker.domain).toEqual({
          name: host,
          aliases: [],
          redirects: [],
        });
        expect(worker.url).toEqual(`https://${host}`);
        expect(worker.urls).toEqual([`https://${host}`]);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 240_000 },
  );
});
