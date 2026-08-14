/**
 * Vercel Function Effect-mode runtime bridge tests — live against the
 * standing Vercel test team (run with the doppler alchemy-v2/dev env).
 *
 * Covers: the two-phase class fixture deployed + driven over HTTP via the
 * production alias, post-response request finalizers, Fluid re-entrancy,
 * the `Function.URL` sentinel (both the Effect accessor and the async
 * `env:` channel), crons landing in the deployment config, the
 * CRON_SECRET-guarded cron route, and the auto-minted protection-bypass
 * secret.
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as deployments from "@distilled.cloud/vercel/deployments";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import EffectFn from "./fixtures/effect-fn.ts";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const asyncFixtureMain = new URL("./fixtures/handler.ts", import.meta.url)
  .pathname;

// Fresh .vercel.app URLs take a few seconds to start serving 200s — always
// retry the first request (bounded).
const readiness = Schedule.max([
  Schedule.exponential("500 millis"),
  Schedule.recurs(20),
]);

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`status ${response.status}`)),
    ),
    Effect.retry({ schedule: readiness }),
  );

const getStatus = (url: string, headers?: Record<string, string>) =>
  HttpClient.get(url, headers !== undefined ? { headers } : undefined).pipe(
    Effect.map((response) => response.status),
  );

/** Poll (bounded) until the function's project is gone. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* projects
      .getProject({ idOrName: projectId, teamId })
      .pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
    expect(gone).toBe(true);
  });

test.provider(
  "effect-mode bridge: fetch, finalizers, self URL, cron guard, bypass, redeploy stability",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EffectFn;
        }),
      );
      expect(fn.url).toBeDefined();
      expect(fn.deploymentId).toBeDefined();
      expect(fn.cronSecret).toBeDefined();
      expect(fn.protectionBypass).toBeDefined();

      // 1. Plain fetch round-trip through the bridge (first-request retry).
      const root = (yield* getJson(`${fn.url}/`)) as { ok: boolean };
      expect(root.ok).toBe(true);

      // 2. Re-entrancy smoke: concurrent requests against the warm
      //    function all complete (each runs in its own fiber + scope).
      const slow = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          getJson(`${fn.url}/slow`).pipe(
            Effect.map((body) => (body as { slow: boolean }).slow),
          ),
        ),
        { concurrency: "unbounded" },
      );
      expect(slow).toEqual([true, true, true, true]);

      // 3. Request finalizers settle POST-response: /finalize registers a
      //    finalizer that sleeps 3s — the response must not wait for it.
      const [elapsed, finalize] = yield* Effect.timed(
        getJson(`${fn.url}/finalize`),
      );
      expect((finalize as { ok: boolean }).ok).toBe(true);
      expect(Duration.toMillis(elapsed)).toBeLessThan(2500);
      // ... and the finalizer DID run afterwards (same warm instance —
      // module-global readback, the probe-verified waitUntil contract).
      const finalized = yield* getJson(`${fn.url}/finalized`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (body) => (body as { finalized: number }).finalized >= 1,
          times: 15,
        }),
      );
      expect((finalized as { finalized: number }).finalized).toBeGreaterThan(0);

      // 4. Function.URL accessor resolves to the read-back production URL.
      const self = (yield* getJson(`${fn.url}/self`)) as { url: string };
      expect(self.url).toEqual(fn.url);

      // 5. The cron landed in the deployment config (read back via
      //    distilled getDeployment).
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const deployment = yield* deployments.getDeployment({
        idOrUrl: fn.deploymentId,
        teamId,
      });
      const crons =
        "crons" in deployment && Array.isArray(deployment.crons)
          ? deployment.crons
          : [];
      expect(crons).toEqual([
        { schedule: "0 3 * * *", path: "/_alchemy/cron/0" },
      ]);

      // 6. The guarded cron route: 401 without the secret, 401 with a wrong
      //    bearer, 200 with the minted CRON_SECRET (which also proves the
      //    handler ran — a failing handler responds 500).
      const cronUrl = `${fn.url}/_alchemy/cron/0`;
      expect(yield* getStatus(cronUrl)).toBe(401);
      expect(
        yield* getStatus(cronUrl, { authorization: "Bearer wrong-secret" }),
      ).toBe(401);
      expect(
        yield* getStatus(cronUrl, {
          authorization: `Bearer ${Redacted.value(fn.cronSecret!)}`,
        }),
      ).toBe(200);

      // 7. CRON_SECRET was synced as a sensitive project env var.
      const envs = yield* projects.filterProjectEnvs({
        idOrName: fn.projectId,
        teamId,
        decrypt: "true",
      });
      const rows = (
        Array.isArray(envs)
          ? envs
          : typeof envs === "object" && envs !== null && "envs" in envs
            ? envs.envs
            : []
      ) as Array<{ key: string; type: string }>;
      const cronRow = rows.find((row) => row.key === "CRON_SECRET");
      expect(cronRow).toBeDefined();
      expect(cronRow!.type).toEqual("sensitive");

      // 8. The protection-bypass secret was minted BEFORE the first deploy
      //    and is exposed (observe-and-keep) — the attribute matches the
      //    project's automation-bypass entry.
      const project = yield* projects.getProject({
        idOrName: fn.projectId,
        teamId,
      });
      const bypassEntry = (
        project.protectionBypass as
          | Record<string, { scope?: string } | undefined>
          | undefined
      )?.[Redacted.value(fn.protectionBypass!)];
      expect(bypassEntry).toBeDefined();
      expect(bypassEntry!.scope).toEqual("automation-bypass");

      // 9. Churn regression: an identical second deploy is a skip-on-hash
      //    no-op — the cron secret and self URL substitution are stable, so
      //    the deployment (and the bypass secret) must not change.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EffectFn;
        }),
      );
      expect(redeployed.projectId).toEqual(fn.projectId);
      expect(redeployed.deploymentId).toEqual(fn.deploymentId);
      expect(Redacted.value(redeployed.cronSecret!)).toEqual(
        Redacted.value(fn.cronSecret!),
      );
      expect(Redacted.value(redeployed.protectionBypass!)).toEqual(
        Redacted.value(fn.protectionBypass!),
      );

      // 10. Destroy cascades the owned project; typed wait-until-gone.
      yield* stack.destroy();
      yield* expectProjectGone(fn.projectId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "async env: Function.URL sentinel resolves to the function's own URL",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Function("SelfEnvFn", {
            main: asyncFixtureMain,
            env: {
              GREETING: "self",
              SELF_URL: Vercel.Function.URL,
            },
          });
        }),
      );
      expect(fn.url).toBeDefined();

      const env = (yield* getJson(`${fn.url}/env`)) as {
        greeting: string | null;
        selfUrl: string | null;
      };
      expect(env.greeting).toEqual("self");
      expect(env.selfUrl).toEqual(fn.url);

      yield* stack.destroy();
      yield* expectProjectGone(fn.projectId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
