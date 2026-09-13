/**
 * CLI-side dashboard launcher: the optional-peer gate, the run-scoped
 * launch over an Alchemist stack session, project discovery, and the
 * browser approval round-trip a `--ui` deploy performs.
 *
 * Everything runs against the CLI's in-memory stack fixture — no cloud,
 * no real browser (`open: false`).
 */
import { routeCacheLayer } from "@/Alchemist/Session.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import * as Discovery from "@/Dashboard/Discovery.ts";
import {
  DashboardNotInstalled,
  requireDistDir,
  resolveDistDir,
} from "@/Dashboard/Dist.ts";
import type { DocumentSnapshot } from "@/Dashboard/Document.ts";
import {
  ensureDashboard,
  launchDashboard,
  requestApprovalViaDashboard,
} from "@/Dashboard/Launch.ts";
import type { Plan } from "@/Plan.ts";
import { describe, expect, test } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as TestCore from "../../src/Test/Core";
import { TestLayers } from "../test.resources";

const fixture = fileURLToPath(
  import.meta.resolve("../Cli/fixtures/import-stack-fixture.ts"),
);

const target = { entrypoint: fixture, stage: "test" };

const run = <A>(effect: Effect.Effect<A, any, any>) =>
  TestCore.run(
    effect.pipe(
      Effect.provide(routeCacheLayer),
      Effect.provide(CliKit.layer({ input: false })),
    ),
    { providers: TestLayers() },
  );

const getJson = <A = any>(url: string) =>
  Effect.tryPromise(async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return {
      status: res.status,
      body: (res.status === 200 ? await res.json() : undefined) as A,
    };
  });

const postJson = (url: string, body: unknown) =>
  Effect.tryPromise(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return res.status;
  });

/** A stand-in SPA bundle so the launcher's optional-peer gate passes. */
const withFakeDist = <A>(body: (dist: string) => Effect.Effect<A, any, any>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dist = yield* fs.makeTempDirectory({ prefix: "alchemy-dashboard-" });
    yield* fs.writeFileString(
      path.join(dist, "index.html"),
      "<!doctype html><title>fake dashboard</title>",
    );
    const previous = process.env.ALCHEMY_DASHBOARD_DIST;
    process.env.ALCHEMY_DASHBOARD_DIST = dist;
    return yield* body(dist).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env.ALCHEMY_DASHBOARD_DIST;
          } else {
            process.env.ALCHEMY_DASHBOARD_DIST = previous;
          }
        }),
      ),
    );
  });

const emptyPlan = {
  resources: {},
  actions: {},
  deletions: {},
  actionDeletions: {},
  output: undefined,
  cycleMembers: new Set<string>(),
} as unknown as Plan;

describe("dashboard launcher", () => {
  test(
    "the optional-peer gate: a missing bundle is a user-facing error, an override is honored",
    () =>
      run(
        Effect.gen(function* () {
          const previous = process.env.ALCHEMY_DASHBOARD_DIST;
          process.env.ALCHEMY_DASHBOARD_DIST = "/nonexistent/alchemy-dashboard";
          const missing = yield* Effect.result(requireDistDir()).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previous === undefined) {
                  delete process.env.ALCHEMY_DASHBOARD_DIST;
                } else {
                  process.env.ALCHEMY_DASHBOARD_DIST = previous;
                }
              }),
            ),
          );
          expect(Result.isFailure(missing)).toBe(true);
          if (Result.isFailure(missing)) {
            expect(missing.failure).toBeInstanceOf(DashboardNotInstalled);
            expect(missing.failure.message).toContain(
              "bun add -D @alchemy.run/dashboard",
            );
          }

          const resolved = yield* withFakeDist((dist) =>
            Effect.all([resolveDistDir(), requireDistDir()]).pipe(
              Effect.map(([a, b]) => ({ dist, a, b })),
            ),
          );
          expect(resolved.a).toBe(resolved.dist);
          expect(resolved.b).toBe(resolved.dist);
        }),
      ),
    { exclusive: true, timeout: 30_000 },
  );

  test(
    "launches over a stack session, advertises itself, and round-trips a browser approval",
    () =>
      run(
        withFakeDist(() =>
          Effect.gen(function* () {
            const ready = yield* Deferred.make<string>();
            const server = yield* Effect.forkScoped(
              launchDashboard({ target, port: 0, open: false, ready }),
            );
            const url = yield* Deferred.await(ready).pipe(
              Effect.timeout("30 seconds"),
            );

            // liveness names the stack the fixture exports
            const health = yield* getJson(`${url}/api/health`);
            expect(health.status).toBe(200);
            expect(health.body).toMatchObject({
              ok: true,
              stack: "import-stack-fixture",
              stage: "test",
            });

            // the document API is served from the session's state store
            const document = yield* getJson<DocumentSnapshot>(
              `${url}/api/v2/document`,
            );
            expect(document.status).toBe(200);
            expect(document.body.meta).toMatchObject({
              stack: "import-stack-fixture",
              stage: "test",
            });

            // the fake bundle is what the SPA route serves
            const index = yield* Effect.tryPromise(async () => {
              const res = await fetch(`${url}/`, {
                signal: AbortSignal.timeout(15_000),
              });
              return res.text();
            });
            expect(index).toContain("fake dashboard");

            // discovery finds the advertisement and health-checks it
            const advertised = yield* Discovery.discover();
            expect(advertised?.url).toBe(url);
            expect(advertised?.stack).toBe("import-stack-fixture");

            // a --ui run in the same project reuses this server
            const ensured = yield* ensureDashboard({
              target,
              stackName: "import-stack-fixture",
              open: false,
            });
            expect(ensured).toEqual({ url, launched: false });

            // browser approval: the deploying side posts the plan and
            // polls; the tab decides through the document's approval id
            const decision = yield* Effect.forkScoped(
              requestApprovalViaDashboard(url, emptyPlan),
            );
            const pending = yield* getJson<DocumentSnapshot>(
              `${url}/api/v2/document`,
            ).pipe(
              Effect.map(({ body }) => body.approval?.id),
              Effect.repeat({
                schedule: Schedule.spaced("100 millis"),
                until: (id): id is string => id !== undefined,
                times: 100,
              }),
            );
            expect(
              yield* postJson(`${url}/api/approval/decide`, {
                id: pending,
                approved: true,
              }),
            ).toBe(200);
            expect(yield* Fiber.join(decision)).toBe(true);

            yield* Fiber.interrupt(server);
            // the advertisement is withdrawn with the server
            expect(yield* Discovery.discover()).toBeUndefined();
          }),
        ),
      ),
    { exclusive: true, timeout: 60_000 },
  );

  test(
    "an unreachable dashboard yields no decision so the terminal prompt can take over",
    () =>
      run(
        Effect.gen(function* () {
          const decision = yield* requestApprovalViaDashboard(
            "http://127.0.0.1:1",
            emptyPlan,
          );
          expect(decision).toBeUndefined();
        }),
      ),
    { timeout: 30_000 },
  );
});
