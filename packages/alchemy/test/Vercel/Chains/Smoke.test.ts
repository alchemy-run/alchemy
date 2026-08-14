/**
 * DEPTH.md chain 7 — the aggregate smoke (§1.1 showcase), live against the
 * standing Vercel test team (doppler alchemy-v2/dev env).
 *
 * ONE stack composing every major surface, driven through SIX reconciliation
 * cycles plus the promote/rollback runtime actions:
 *
 *   SmokeFlags (EdgeConfig) ─┐
 *   SmokeUploads (BlobStore) ┼─▶ SmokeApi (Effect Function: ReadEdgeConfig +
 *   SmokeJobs/SmokeEchoes ───┘    ReadWriteBlob + SendMessage + subscribe +
 *                                 cron, rotated Redacted release secret)
 *                                   │ url / protectionBypass (env channel)
 *                                   ▼
 *                                 SmokeSurface (async fn) — /call proxies
 *                                 the Api's /version through env-bound URL
 *   SmokeSite (Website.StaticSite) — independent content deploys
 *   Pinned (Alias) — stable hostname pinned to the Api's CURRENT deployment
 *
 * Cycles (each asserts BOTH what changed AND what stayed stable):
 *   1. greenfield — every route/binding live end-to-end (flags, blob, queue
 *      push delivery, cron guard, cross-fn env URL, static content, alias)
 *   2. no-op redeploy — every deploymentId/uid/digest/token identical
 *   2b. EdgeConfig item flip ONLY — served flag changes while the bound
 *      Api's deploymentId stays STABLE (data-plane-only propagation)
 *   3. multi-prop mutation in ONE deploy — items + Redacted rotation +
 *      static content: changed resources redeploy, siblings stay stable,
 *      blob data survives, queue path works on the successor deployment
 *   4. rollbackProduction → old release served WITHOUT rebuild (deployment
 *      count frozen), EdgeConfig reads on the rolled-back deployment serve
 *      the NEW items (data plane is deployment-independent), and the pinned
 *      alias is SWEPT to the rollback target (live-verified platform
 *      semantics — aliases riding the outgoing production deployment move
 *      with it) → promoteToProduction sweeps everything forward again
 *   5. post-action convergence — identical redeploy after the traffic
 *      actions is a full no-op (the actions never confuse reconcile)
 *   6. destroy — census-clean via typed distilled reads (projects, config,
 *      store, alias all gone; queue messages expire via 300s retention —
 *      the platform has no topic-delete API)
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as aliases from "@distilled.cloud/vercel/aliases";
import * as deployments from "@distilled.cloud/vercel/deployments";
import * as globalConfig from "@distilled.cloud/vercel/global_config";
import * as projects from "@distilled.cloud/vercel/projects";
import * as storage from "@distilled.cloud/vercel/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import SmokeApi, { type JobEcho, setApiRelease } from "./fixtures/smoke-api.ts";
import { SmokeUploads } from "./fixtures/smoke-store.ts";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const surfaceMain = new URL("./fixtures/smoke-surface.ts", import.meta.url)
  .pathname;

// Deterministic stable hostname (global .vercel.app namespace — owned by
// the standing test team after the first run).
const SMOKE_ALIAS = "alchemy-vrc-smoke-e2e.vercel.app";

// Fresh .vercel.app URLs take a few seconds to start serving 200s — always
// retry the first request. Bounded: `times` is the hard cap (the schedule
// alone never terminates).
const readiness = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("2 seconds"),
]);

const getJson = (url: string, headers?: Record<string, string>) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(
      url,
      headers !== undefined ? { headers } : undefined,
    );
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`status ${response.status}: ${body.slice(0, 300)}`),
      );
    }
    // Fresh production aliases can transiently serve an HTML edge
    // placeholder — treat an unparseable body as retryable, not a crash.
    return yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: () =>
        new Error(`status 200 but non-JSON body: ${body.slice(0, 300)}`),
    });
  }).pipe(Effect.retry({ schedule: readiness, times: 40 }));

/** Bounded poll of a JSON route until the body matches. */
const pollJson = <A>(
  url: string,
  until: (body: A) => boolean,
  options?: { headers?: Record<string, string>; times?: number },
) =>
  getJson(url, options?.headers).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => until(body as A),
      times: options?.times ?? 20,
    }),
    Effect.map((body) => body as A),
  );

const getText = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text
        : Effect.fail(new Error(`status ${response.status}`)),
    ),
    Effect.retry({ schedule: readiness, times: 40 }),
  );

const getStatus = (url: string, headers?: Record<string, string>) =>
  HttpClient.get(url, headers !== undefined ? { headers } : undefined).pipe(
    Effect.map((response) => response.status),
  );

/** Poll (bounded) until the API serves the given release version. */
const expectVersion = (
  url: string,
  version: string,
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const body = yield* pollJson<{ version: string | null }>(
      `${url}/version`,
      (b) => b.version === version,
      { headers },
    );
    expect(body.version).toEqual(version);
  });

/** Poll (bounded) until a project is gone (typed NotFound). */
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

const htmlPage = (marker: string) =>
  `<!doctype html>\n<html><body><h1>${marker}</h1></body></html>\n`;

test.provider(
  "aggregate smoke: 5 reconcile cycles + rollback/promote across the whole surface",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runId = yield* Effect.sync(() => crypto.randomUUID());

      // ── Static-site fixture in a temp dir (deterministic content).
      const dir = yield* fs.makeTempDirectory({
        prefix: "alchemy-vercel-chain-smoke-",
      });
      yield* Effect.addFinalizer(() =>
        Effect.ignore(fs.remove(dir, { recursive: true })),
      );
      yield* fs.makeDirectory(path.join(dir, "src"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, ".gitignore"), "dist\n");
      const buildSh = path.join(dir, "build.sh");
      yield* fs.writeFileString(
        buildSh,
        "#!/bin/sh\nmkdir -p dist\ncp src/index.html dist/index.html\n",
      );
      yield* fs.chmod(buildSh, 0o755);
      const writeSiteMarker = (marker: string) =>
        fs.writeFileString(
          path.join(dir, "src", "index.html"),
          htmlPage(marker),
        );
      yield* writeSiteMarker("smoke-site-v1");

      // ── The whole-stack program. The EdgeConfig registers FIRST with the
      //    cycle's declarative items, so the fixture Api's binding resolves
      //    the same instance (FQN-idempotent registration).
      const program = (items: Record<string, unknown>) =>
        Effect.gen(function* () {
          const flags = yield* Vercel.EdgeConfig("SmokeFlags", { items });
          const store = yield* SmokeUploads;
          const api = yield* SmokeApi;
          const surface = yield* Vercel.Function("SmokeSurface", {
            main: surfaceMain,
            env: {
              API_URL: api.url,
              API_BYPASS: api.protectionBypass,
            },
          });
          const site = yield* Vercel.Website.StaticSite("SmokeSite", {
            command: "./build.sh",
            cwd: dir,
            outdir: "dist",
          });
          const alias = yield* Vercel.Alias("Pinned", {
            alias: SMOKE_ALIAS,
            deployment: api.deploymentId,
          });
          return { flags, store, api, surface, site, alias };
        });

      const itemsV1 = {
        greeting: "hello",
        enableCheckout: true,
        limits: { maxItems: 3 },
      };

      // ═══ CYCLE 1 — greenfield: everything deploys and every surface is
      //     live end-to-end.
      setApiRelease("v1", "smoke-secret-v1");
      const c1 = yield* stack.deploy(program(itemsV1));

      expect(c1.flags.edgeConfigId).toMatch(/^ecfg_/);
      expect(c1.api.projectId).toBeDefined();
      expect(c1.api.deploymentId).toBeTruthy();
      expect(c1.api.url).toMatch(/^https:\/\/.+\.vercel\.app$/);
      expect(c1.api.cronSecret).toBeDefined();
      expect(c1.api.protectionBypass).toBeDefined();
      expect(c1.surface.deploymentId).toBeTruthy();
      expect(c1.site.deploymentId).toBeTruthy();
      expect(c1.alias.uid).toBeDefined();
      expect(c1.alias.deploymentId).toEqual(c1.api.deploymentId);
      expect(c1.alias.url).toEqual(`https://${SMOKE_ALIAS}`);
      const bypass = {
        "x-vercel-protection-bypass": Redacted.value(c1.api.protectionBypass!),
      };

      // 1a. Release route serves v1 (production alias).
      yield* expectVersion(c1.api.url!, "v1");

      // 1b. EdgeConfig binding: declared items served through the deployed
      //     client (data plane is eventually consistent — bounded poll).
      const greeting1 = yield* pollJson<{ value: unknown }>(
        `${c1.api.url}/flag/greeting`,
        (b) => b.value === "hello",
      );
      expect(greeting1.value).toEqual("hello");

      // 1c. Blob binding: write once here, read back NOW and again after
      //     the cycle-3 redeploy (data continuity across reconciles).
      const blobPath = `chain-smoke/${runId}.txt`;
      const put = (yield* getJson(
        `${c1.api.url}/blob/put?path=${encodeURIComponent(blobPath)}&body=cycle1-${runId}`,
      )) as { etag: string; pathname: string };
      expect(put.etag).toBeTruthy();
      expect(put.pathname).toEqual(blobPath);
      const got1 = (yield* getJson(
        `${c1.api.url}/blob/get?path=${encodeURIComponent(blobPath)}`,
      )) as { text?: string };
      expect(got1.text).toEqual(`cycle1-${runId}`);
      //     …and the capability binding (not a projects: prop) is what
      //     connected the store to the Api's project.
      expect(c1.store.storeId).toMatch(/^store_/);
      const conns = yield* storage.getStorageStoreConnections({
        storeId: c1.store.storeId,
        teamId,
      });
      expect(conns.connections.map((c) => c.projectId)).toContain(
        c1.api.projectId,
      );

      // 1d. Queue: produce through the public route (deployment-pinned
      //     ambient OIDC), platform push-delivers to the generated consumer
      //     func, which echoes into SmokeEchoes; /received drains it.
      const queued = (yield* getJson(
        `${c1.api.url}/send?runId=${runId}&jobId=smoke-c1`,
      )) as { queued: boolean };
      expect(queued.queued).toBe(true);
      const drained = yield* pollJson<{ received: JobEcho[] }>(
        `${c1.api.url}/received`,
        (b) =>
          b.received.some((e) => e.runId === runId && e.jobId === "smoke-c1"),
        { times: 40 },
      );
      const echo = drained.received.find((e) => e.jobId === "smoke-c1")!;
      expect(echo.deliveryCount).toBeGreaterThanOrEqual(1);
      expect(echo.topicName).toEqual("alchemy-smoke-jobs");
      expect(echo.consumerGroup).toEqual("alchemy-SmokeApi");

      // 1e. Cron: the schedule landed on the deployment (distilled read),
      //     and the guarded route rejects/accepts correctly.
      const deployment1 = yield* deployments.getDeployment({
        idOrUrl: c1.api.deploymentId,
        teamId,
      });
      const crons =
        "crons" in deployment1 && Array.isArray(deployment1.crons)
          ? deployment1.crons
          : [];
      expect(crons).toEqual([
        { schedule: "0 3 * * *", path: "/_alchemy/cron/0" },
      ]);
      const cronUrl = `${c1.api.url}/_alchemy/cron/0`;
      expect(yield* getStatus(cronUrl)).toBe(401);
      expect(
        yield* getStatus(cronUrl, {
          authorization: `Bearer ${Redacted.value(c1.api.cronSecret!)}`,
        }),
      ).toBe(200); // 200 ⇒ the handler ran (a failing cron handler answers 500)

      // 1f. Cross-function env channel: the async surface fn reaches the
      //     Api's CURRENT production release through its env-bound URL.
      const call1 = yield* pollJson<{
        status: number;
        body: { version: string | null };
      }>(`${c1.surface.url}/call`, (b) => b.status === 200);
      expect(call1.body.version).toEqual("v1");

      // 1g. Static site serves its content.
      const site1 = yield* getText(`${c1.site.url}/index.html`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (t) => t.includes("smoke-site-v1"),
          times: 20,
        }),
      );
      expect(site1).toContain("smoke-site-v1");

      // 1h. The pinned alias serves the Api (SSO-gated deployment alias —
      //     bypass secret, minted before the first deploy, opens it).
      yield* expectVersion(c1.alias.url, "v1", bypass);

      // ═══ CYCLE 2 — no-op redeploy: EVERYTHING stays stable.
      const c2 = yield* stack.deploy(program(itemsV1));
      expect(c2.api.deploymentId).toEqual(c1.api.deploymentId);
      expect(c2.surface.deploymentId).toEqual(c1.surface.deploymentId);
      expect(c2.site.deploymentId).toEqual(c1.site.deploymentId);
      expect(c2.flags.edgeConfigId).toEqual(c1.flags.edgeConfigId);
      expect(c2.flags.digest).toEqual(c1.flags.digest);
      expect(c2.alias.uid).toEqual(c1.alias.uid);
      expect(c2.alias.deploymentId).toEqual(c1.api.deploymentId);

      // ═══ CYCLE 2b — EdgeConfig item flip ONLY: the served flag changes
      //     while the bound Api's deployment is untouched. THE §1.1 story:
      //     config propagation is data-plane-only — no rebuild, no redeploy.
      const c2b = yield* stack.deploy(
        program({ ...itemsV1, greeting: "howdy" }),
      );
      expect(c2b.api.deploymentId).toEqual(c1.api.deploymentId); // STABLE
      expect(c2b.surface.deploymentId).toEqual(c1.surface.deploymentId);
      expect(c2b.site.deploymentId).toEqual(c1.site.deploymentId);
      expect(c2b.flags.edgeConfigId).toEqual(c1.flags.edgeConfigId); // same config
      expect(c2b.flags.digest).not.toEqual(c1.flags.digest); // new content
      const greeting2b = yield* pollJson<{ value: unknown }>(
        `${c1.api.url}/flag/greeting`,
        (b) => b.value === "howdy",
      );
      expect(greeting2b.value).toEqual("howdy");

      // ═══ CYCLE 3 — multi-prop mutation in ONE deploy: EdgeConfig items
      //     evolve + the Api's Redacted secret rotates (v2 release) + the
      //     static site's content changes. All converge; siblings stable.
      const itemsV2 = {
        greeting: "hola",
        enableCheckout: false,
        rolloutPercent: 25,
      };
      setApiRelease("v2", "smoke-secret-v2");
      yield* writeSiteMarker("smoke-site-v2");
      const c3 = yield* stack.deploy(program(itemsV2));

      // Changed: the Api minted a NEW immutable deployment (rotation)…
      expect(c3.api.projectId).toEqual(c1.api.projectId);
      expect(c3.api.deploymentId).not.toEqual(c1.api.deploymentId);
      // …the site rebuilt and redeployed…
      expect(c3.site.projectId).toEqual(c1.site.projectId);
      expect(c3.site.deploymentId).not.toEqual(c1.site.deploymentId);
      // …the config content moved again…
      expect(c3.flags.digest).not.toEqual(c2b.flags.digest);
      // …and the pinned alias re-pointed to the new deployment IN PLACE.
      expect(c3.alias.uid).toEqual(c1.alias.uid);
      expect(c3.alias.deploymentId).toEqual(c3.api.deploymentId);
      // Stable: the surface fn (its env — the Api's URL + bypass — did not
      // change), the config identity, the Api's URL itself.
      expect(c3.surface.deploymentId).toEqual(c1.surface.deploymentId);
      expect(c3.flags.edgeConfigId).toEqual(c1.flags.edgeConfigId);
      expect(c3.api.url).toEqual(c1.api.url);

      // The new release + rotated secret are served…
      const v2body = yield* pollJson<{
        version: string | null;
        secretTail: string | null;
      }>(`${c1.api.url}/version`, (b) => b.version === "v2");
      expect(v2body.secretTail).toEqual("v2");
      // …the evolved items too…
      const greeting3 = yield* pollJson<{ value: unknown }>(
        `${c1.api.url}/flag/greeting`,
        (b) => b.value === "hola",
      );
      expect(greeting3.value).toEqual("hola");
      // …cycle-1 blob data SURVIVED the redeploy (same store, same token)…
      const got3 = (yield* getJson(
        `${c1.api.url}/blob/get?path=${encodeURIComponent(blobPath)}`,
      )) as { text?: string };
      expect(got3.text).toEqual(`cycle1-${runId}`);
      // …the queue path works on the successor deployment (sends pin to the
      // NEW deployment partition; its consumer trigger receives them)…
      yield* getJson(`${c1.api.url}/send?runId=${runId}&jobId=smoke-c3`);
      const drained3 = yield* pollJson<{ received: JobEcho[] }>(
        `${c1.api.url}/received`,
        (b) =>
          b.received.some((e) => e.runId === runId && e.jobId === "smoke-c3"),
        { times: 40 },
      );
      expect(drained3.received.some((e) => e.jobId === "smoke-c3")).toBe(true);
      // …the surface fn now reports v2 through the SAME deployment of its
      // own (env-bound URL tracks production)…
      yield* pollJson<{ status: number; body: { version: string | null } }>(
        `${c1.surface.url}/call`,
        (b) => b.status === 200 && b.body.version === "v2",
      );
      // …and the site serves the new marker.
      const site3 = yield* getText(`${c1.site.url}/index.html`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (t) => t.includes("smoke-site-v2"),
          times: 20,
        }),
      );
      expect(site3).toContain("smoke-site-v2");

      // ═══ CYCLE 4 — rollback/promote runtime actions (pure traffic ops).
      const countBefore = (yield* deployments.getDeployments({
        teamId,
        projectId: c1.api.projectId,
        limit: 20,
      })).deployments.length;

      // Roll production back to the v1 release: served WITHOUT rebuild.
      yield* Vercel.rollbackProduction(c3.api.projectId, c1.api.deploymentId, {
        description: "chain-smoke rollback",
      });
      yield* expectVersion(c1.api.url!, "v1");
      // The rolled-back deployment carries the OLD secret snapshot (env is
      // per-deployment)…
      const rolled = (yield* getJson(`${c1.api.url}/version`)) as {
        secretTail: string | null;
      };
      expect(rolled.secretTail).toEqual("v1");
      // …but EdgeConfig reads on it serve the NEW items — the data plane is
      // deployment-independent (flag flips survive rollbacks instantly).
      const rolledFlag = (yield* getJson(`${c1.api.url}/flag/greeting`)) as {
        value: unknown;
      };
      expect(rolledFlag.value).toEqual("hola");
      // The pinned alias is SWEPT by instant rollback (live-verified,
      // .probes/chain7-rollback-alias-sweep.ts): rollback re-points EVERY
      // alias riding the outgoing production deployment to the rollback
      // target, so an alias pinned to the ACTIVE production deployment
      // tracks production through rollback/promote rather than staying put.
      const sweptTo = yield* aliases
        .getAlias({ idOrAlias: SMOKE_ALIAS, teamId })
        .pipe(
          Effect.map((a) => a.deploymentId ?? undefined),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (d) => d === c1.api.deploymentId,
            times: 10,
          }),
        );
      expect(sweptTo).toEqual(c1.api.deploymentId);
      yield* expectVersion(c1.alias.url, "v1", bypass);
      // No rebuild happened: the project's deployment count is frozen.
      const countAfter = (yield* deployments.getDeployments({
        teamId,
        projectId: c1.api.projectId,
        limit: 20,
      })).deployments.length;
      expect(countAfter).toEqual(countBefore);

      // Promote forward again — the sweep works in both directions: the
      // pinned alias rides back to the promoted deployment.
      yield* Vercel.promoteToProduction(c3.api.projectId, c3.api.deploymentId);
      yield* expectVersion(c1.api.url!, "v2");
      const sweptBack = yield* aliases
        .getAlias({ idOrAlias: SMOKE_ALIAS, teamId })
        .pipe(
          Effect.map((a) => a.deploymentId ?? undefined),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (d) => d === c3.api.deploymentId,
            times: 10,
          }),
        );
      expect(sweptBack).toEqual(c3.api.deploymentId);
      yield* expectVersion(c1.alias.url, "v2", bypass);
      // The surface fn tracked production through both flips (same env).
      yield* pollJson<{ status: number; body: { version: string | null } }>(
        `${c1.surface.url}/call`,
        (b) => b.status === 200 && b.body.version === "v2",
      );

      // ═══ CYCLE 5 — post-action convergence: an identical redeploy after
      //     the out-of-band traffic actions is a full no-op.
      const c5 = yield* stack.deploy(program(itemsV2));
      expect(c5.api.deploymentId).toEqual(c3.api.deploymentId);
      expect(c5.surface.deploymentId).toEqual(c1.surface.deploymentId);
      expect(c5.site.deploymentId).toEqual(c3.site.deploymentId);
      expect(c5.flags.digest).toEqual(c3.flags.digest);
      expect(c5.alias.uid).toEqual(c1.alias.uid);
      expect(c5.alias.deploymentId).toEqual(c3.api.deploymentId);

      // ═══ CYCLE 6 — destroy: census-clean via typed distilled reads.
      yield* stack.destroy();

      yield* expectProjectGone(c1.api.projectId);
      yield* expectProjectGone(c1.surface.projectId);
      yield* expectProjectGone(c1.site.projectId);
      const configGone = yield* globalConfig
        .getEdgeConfig({ edgeConfigId: c1.flags.edgeConfigId, teamId })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (g) => g,
            times: 8,
          }),
        );
      expect(configGone).toBe(true);
      const storeGone = yield* storage
        .getStorageStoresById({ id: c1.store.storeId, teamId })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (g) => g,
            times: 8,
          }),
        );
      expect(storeGone).toBe(true);
      const aliasGone = yield* aliases
        .getAlias({ idOrAlias: SMOKE_ALIAS, teamId })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (g) => g,
            times: 8,
          }),
        );
      expect(aliasGone).toBe(true);
      // Queue topics: the platform has no topic-delete API — messages on
      // both topics expire on their own (retentionSeconds: 300).
    }).pipe(logLevel),
  // Six reconcile cycles + platform queue push delivery + rollback/promote
  // + census in ONE sequential chain (measured ~80s green; 3x headroom).
  { timeout: 240_000 },
);
