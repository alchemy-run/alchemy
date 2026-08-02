/**
 * REPRODUCTION for the "Vite site on a zone route with a path prefix" bug.
 *
 * Cloudflare matches static assets against the FULL request pathname
 * (https://developers.cloudflare.com/workers/static-assets/routing/advanced/serving-a-subdirectory/):
 * a Worker routed at `zone/prefix*` only serves an asset for
 * `/prefix/index.html` if the uploaded asset manifest contains
 * `/prefix/index.html`. The Vite resource uploads the client build rooted
 * at `/`, so a site attached via `routes: [{ pattern: "zone/prefix*" }]`
 * 404s (or, with SPA fallback, serves HTML whose root-absolute
 * `/assets/*.js` URLs fall outside the route entirely).
 *
 * This test pins the CURRENT (broken) behavior: the same deploy works on
 * workers.dev but does not serve a working page on the route. A fix should
 * flip the `routeResult` expectations.
 */
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const spaFixtureDir = pathe.resolve(import.meta.dirname, "vite-spa-fixture");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const zoneName =
  process.env.CLOUDFLARE_TEST_WORKER_ROUTE_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-user path prefix on the zone apex (never Date.now()).
const routePrefix = `alchemy-vite-route-repro-${process.env.PULL_REQUEST ?? process.env.USER}`;
const routePattern = `${zoneName}/${routePrefix}/app*`;
const routePageUrl = `https://${zoneName}/${routePrefix}/app/`;

const marker = "vite-route-prefix-repro";

const htmlPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${marker}</title>
  </head>
  <body>
    <div id="app">${marker}</div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

const forbiddenRetrySchedule = Schedule.exponential("500 millis");

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

// Workers only run on proxied hostnames — the apex placeholder is standing
// test-zone infrastructure (see WorkerRoutes.test.ts); ensure, never delete.
const ensureApexPlaceholder = (zoneId: string) =>
  Effect.gen(function* () {
    const existing = yield* dns.listRecords.items({ zoneId }).pipe(
      Stream.filter(
        (r) => r.name === zoneName && (r.type === "A" || r.type === "AAAA"),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)[0]),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );
    if (existing) return;
    yield* dns.createRecord({
      zoneId,
      name: zoneName,
      type: "AAAA",
      content: "100::",
      proxied: true,
      ttl: 1,
      comment: "standing placeholder so Workers routes serve on the zone apex",
    });
  });

const purgeRoutes = (zoneId: string, ...patterns: string[]) =>
  Effect.forEach(patterns, (pattern) =>
    workers.listRoutes.items({ zoneId }).pipe(
      Stream.filter((r) => r.pattern === pattern),
      Stream.runCollect,
      Effect.flatMap(
        Effect.forEach((r) =>
          workers
            .deleteRoute({ zoneId, routeId: r.id })
            .pipe(Effect.catch(() => Effect.void)),
        ),
      ),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    ),
  );

class ProbeFailed extends Data.TaggedError("ProbeFailed")<{
  url: string;
  message: string;
}> {}

interface ProbeResult {
  url: string;
  status: number;
  contentType: string | undefined;
  body: string;
}

// One GET with cache busting; retried below until the edge stops serving
// 5xx / Cloudflare error pages (route + worker propagation).
const probeOnce = (url: string) =>
  Effect.tryPromise({
    try: async (signal): Promise<ProbeResult> => {
      const u = new URL(url);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        headers: { "cache-control": "no-cache", accept: "*/*" },
      });
      const body = await res.text();
      return {
        url,
        status: res.status,
        contentType: res.headers.get("content-type") ?? undefined,
        body,
      };
    },
    catch: (e) =>
      new ProbeFailed({
        url,
        message: e instanceof Error ? e.message : String(e),
      }),
  });

const isPropagating = (r: ProbeResult) =>
  r.status >= 500 ||
  r.body.includes("There is nothing here yet") ||
  /Error\s+1\d{3}/i.test(r.body);

const probeStable = (url: string) =>
  probeOnce(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (r: ProbeResult) => !isPropagating(r),
      times: 20,
    }),
    Effect.retry({
      while: (e) => e._tag === "ProbeFailed",
      schedule: Schedule.exponential("1 second"),
      times: 5,
    }),
  );

const excerpt = (s: string) => s.replace(/\s+/g, " ").slice(0, 200);

/**
 * End-to-end "does the SPA actually work here" check: the page must serve
 * the marker HTML AND the module script it references must be fetchable
 * (as JavaScript) from the same host.
 */
const evaluateSite = Effect.fn(function* (pageUrl: string, label: string) {
  const page = yield* probeStable(pageUrl);
  yield* Effect.log(
    `[${label}] page ${page.status} ${page.contentType ?? "-"} :: ${excerpt(page.body)}`,
  );
  const src = page.body.match(/<script[^>]+src="([^"]+)"/)?.[1];
  let script: ProbeResult | undefined;
  if (page.status === 200 && src) {
    const scriptUrl = new URL(src, pageUrl).toString();
    script = yield* probeStable(scriptUrl);
    yield* Effect.log(
      `[${label}] script ${scriptUrl} -> ${script.status} ${script.contentType ?? "-"} :: ${excerpt(script.body)}`,
    );
  }
  const works =
    page.status === 200 &&
    page.body.includes(marker) &&
    script !== undefined &&
    script.status === 200 &&
    (script.contentType?.includes("javascript") ?? false);
  return { works, page, script };
});

test.provider.skipIf(!zoneName)(
  "Vite: assets do not serve on a zone route with a path prefix (repro)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRoutes(zoneId, routePattern);
      yield* ensureApexPlaceholder(zoneId);

      const rootDir = yield* cloneFixture(spaFixtureDir, {
        prefix: "alchemy-vite-route-",
        tempRoot,
        entries: ["index.html", "package.json", "src"],
      });
      yield* fs.writeFileString(path.join(rootDir, "index.html"), htmlPage);
      const memoInclude = ["index.html", "src/**", "package.json"];

      let workerName: string | undefined;

      yield* Effect.gen(function* () {
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Vite("ViteRoutePrefix", {
              rootDir,
              workersDev: true,
              compatibility: {
                date: "2024-09-23",
                flags: ["nodejs_compat"],
              },
              memo: { include: memoInclude },
              routes: [{ pattern: routePattern, zoneName }],
            });
          }),
        );
        workerName = site.workerName;

        expect(site.url).toBeDefined();
        expect(site.routes).toHaveLength(1);
        expect(site.routes[0]?.pattern).toEqual(routePattern);

        // Control — the very same deploy serves fine on workers.dev.
        yield* expectUrlContains(`${site.url!}/`, marker, {
          timeout: "120 seconds",
          label: "workers.dev control",
        });
        const control = yield* evaluateSite(`${site.url!}/`, "workers.dev");
        expect(control.works).toBe(true);

        // Repro — the route URL does NOT serve a working page, because the
        // asset manifest is rooted at "/" while requests arrive under
        // "/<prefix>/app/". A fix should make this evaluate to true.
        const routeResult = yield* evaluateSite(routePageUrl, "zone route");
        expect(routeResult.works).toBe(false);

        // The specific failure shape today: the manifest has no
        // `/<prefix>/app/index.html`, so the page request misses assets
        // entirely (404 from the assets-only worker, or an SPA fallback
        // whose root-absolute script URL escapes the route).
        expect(routeResult.page.status).not.toBe(200);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            yield* purgeRoutes(zoneId, routePattern).pipe(Effect.ignore);
            if (workerName) {
              yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(
                Effect.ignore,
              );
            }
          }),
        ),
      );
    }).pipe(logLevel),
  { timeout: 360_000 },
);
