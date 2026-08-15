/**
 * Preview tenancy — the cross-stage story (DESIGN §5.1), live against the
 * standing Vercel test team (run with the doppler alchemy-v2/dev env).
 *
 * Topology under test:
 *
 *   stage "staging"  — deploys the shared `Vercel.Project` and a tenant
 *                      `Vercel.Function` targeting PRODUCTION of it, and
 *                      exports the project through the stack output.
 *   stage "pr7"      — a preview tenant: deploys the same Function shape
 *                      into the SHARED project via the cross-stage ref
 *                      (`Alchemy.stackRef` → `project:`), landing an
 *                      ADDITIVE preview deployment behind the stable
 *                      per-stage alias `{projectName}-pr7.vercel.app`.
 *   stage "prc"      — pins the MANDATORY cross-tenant env conflict check:
 *                      a tenant env key that already exists in project env
 *                      (`ALCHEMY_META`, the ownership stamp) is a typed
 *                      `Vercel.TenantEnvConflict`, because project env WINS
 *                      over per-deployment env (PROBES.md probe 3).
 *
 * Assertions: additive preview deployments (staging's production deployment
 * and URL untouched), stable per-stage alias serving through the automation
 * bypass secret (assign-created `.vercel.app` aliases are SSO-gated on team
 * accounts), per-deployment env delivery via `.vc-config.json` (tenant keys
 * NEVER appear in project env), skip-on-hash redeploy stability, PR-stage
 * destroy that removes ONLY its alias + meta-stamped deployments, and the
 * staging-destroy refusal while its tenant production deployment is active.
 */
import * as Alchemy from "@/index.ts";
import type * as OutputNS from "@/Output.ts";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as aliases from "@distilled.cloud/vercel/aliases";
import * as deployments from "@distilled.cloud/vercel/deployments";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test, deploy, destroy } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureMain = new URL("./fixtures/handler.ts", import.meta.url).pathname;

const APP = "vercel-fn-tenancy";
const STAGING = "staging";
const PR = "pr7";
const CONFLICT = "prc";

/** staging: the shared project + its production owner (a tenant Function). */
const StagingStack = Alchemy.Stack(
  APP,
  { providers: Vercel.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const shared = yield* Vercel.Project("Shared");
    const prod = yield* Vercel.Function("Prod", {
      main: fixtureMain,
      project: shared.projectId,
      target: "production",
      env: { GREETING: "staging-production" },
    });
    return {
      projectId: shared.projectId.as<string>(),
      projectName: shared.projectName.as<string>(),
      prodDeploymentId: prod.deploymentId.as<string>(),
      prodUrl: prod.url.as<string>(),
    };
  }),
);

/** PR stage: a preview tenant of staging's project via the cross-stage ref. */
const PreviewStack = Alchemy.Stack(
  APP,
  { providers: Vercel.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const staging = (yield* Alchemy.stackRef<{ projectId: string }>(APP, {
      stage: STAGING,
    })) as unknown as OutputNS.ToOutput<{ projectId: string }>;
    const fn = yield* Vercel.Function("PrFn", {
      main: fixtureMain,
      project: staging.projectId,
      env: { GREETING: "pr-preview" },
    });
    return {
      projectId: fn.projectId.as<string>(),
      deploymentId: fn.deploymentId.as<string>(),
      url: fn.url.as<string>(),
      alias: fn.stageAlias.as<{ uid: string; alias: string }>(),
    };
  }),
);

/** Conflict stage: tenant env key that already lives in project env. */
const ConflictStack = Alchemy.Stack(
  APP,
  { providers: Vercel.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const staging = (yield* Alchemy.stackRef<{ projectId: string }>(APP, {
      stage: STAGING,
    })) as unknown as OutputNS.ToOutput<{ projectId: string }>;
    const fn = yield* Vercel.Function("Conflict", {
      main: fixtureMain,
      project: staging.projectId,
      // ALCHEMY_META is the ownership stamp the Project resource keeps in
      // PROJECT env — a guaranteed key conflict.
      env: { ALCHEMY_META: "shadowed" },
    });
    return { deploymentId: fn.deploymentId.as<string>() };
  }),
);

/** Robust failure → text (aggregated causes may resist stringification). */
const describeFailure = (failure: unknown): string => {
  const base = String(failure);
  try {
    return `${base} ${JSON.stringify(failure)}`;
  } catch {
    return base;
  }
};

const getJson = (url: string, bypass?: string) =>
  HttpClient.get(
    url,
    bypass !== undefined
      ? { headers: { "x-vercel-protection-bypass": bypass } }
      : undefined,
  ).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`status ${response.status}`)),
    ),
    // Fresh aliases/deployments take a few seconds to start serving —
    // always retry the first request (bounded, ~20s worst case).
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
  );

/** The project's automation bypass secret (minted by the tenant reconcile). */
const readBypass = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const project = yield* projects.getProject({ idOrName: projectId, teamId });
    const entry = Object.entries(project.protectionBypass ?? {}).find(
      ([, value]) =>
        (value as { scope?: string } | undefined)?.scope ===
        "automation-bypass",
    );
    expect(entry).toBeDefined();
    return entry![0];
  });

/** Out-of-band deployment observation (undefined = gone). */
const observeDeployment = (id: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    return yield* deployments
      .getDeployment({ idOrUrl: id, teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  });

/** Out-of-band alias observation (undefined = gone). */
const observeAlias = (aliasName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    return yield* aliases
      .getAlias({ idOrAlias: aliasName, teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  });

const projectEnvKeys = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const body = yield* projects.filterProjectEnvs({
      idOrName: projectId,
      teamId,
    });
    const rows =
      typeof body === "object" && body !== null && "envs" in body
        ? (body.envs as Array<{ key: string }>)
        : [];
    return rows.map((row) => row.key);
  });

/**
 * Teardown-only: retire the shared project's active production deployment
 * so the staging destroy (which refuses to brick a live production) can
 * proceed — the project itself is being retired.
 */
const retireProduction = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const page = yield* deployments.getDeployments({
      teamId,
      projectId,
      limit: 100,
    });
    for (const d of page.deployments) {
      if (d.target === "production") {
        yield* deployments
          .deleteDeployment({ id: d.uid, teamId })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
    }
  });

/** Poll (bounded) until the shared project is gone. */
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
  "preview tenancy: cross-stage tenant is additive, per-stage alias + per-deployment env, stage destroy leaves the shared project intact",
  () => {
    // Captured for the crash-safe teardown below.
    let sharedProjectId: string | undefined;

    const teardown = Effect.gen(function* () {
      yield* destroy(PreviewStack, { stage: PR }).pipe(Effect.ignore);
      yield* destroy(ConflictStack, { stage: CONFLICT }).pipe(Effect.ignore);
      if (sharedProjectId !== undefined) {
        yield* retireProduction(sharedProjectId).pipe(Effect.ignore);
      }
      yield* destroy(StagingStack, { stage: STAGING }).pipe(Effect.ignore);
    });

    return Effect.gen(function* () {
      // ── 1. Deploy the durable staging stage. A previously crashed run's
      //       leftovers converge here (deterministic names + engine state).
      const staging = yield* deploy(StagingStack, { stage: STAGING });
      sharedProjectId = staging.projectId;
      expect(staging.projectId).toBeDefined();
      expect(staging.prodDeploymentId).toBeDefined();

      // The tenant reconcile minted the automation bypass BEFORE its first
      // deploy (bypass secrets only open post-mint deployments).
      const bypass = yield* readBypass(staging.projectId);

      // Staging's production serves on the project's production alias.
      const prodBody = (yield* getJson(`${staging.prodUrl}/env`, bypass)) as {
        greeting: string | null;
      };
      expect(prodBody.greeting).toEqual("staging-production");

      // ── 2. Deploy the PR stage as a preview tenant via the cross-stage
      //       reference — same shared project, ADDITIVE deployment.
      const pr = yield* deploy(PreviewStack, { stage: PR });
      expect(pr.projectId).toEqual(staging.projectId);
      expect(pr.deploymentId).not.toEqual(staging.prodDeploymentId);

      // Stable per-stage alias: {projectName}-{stage}.vercel.app.
      expect(pr.alias).toBeDefined();
      expect(pr.alias.alias).toEqual(`${staging.projectName}-${PR}.vercel.app`);
      expect(pr.url).toEqual(`https://${pr.alias.alias}`);

      // The PR deployment is a PREVIEW deployment (no production target)…
      const prDep = yield* observeDeployment(pr.deploymentId);
      expect(prDep).toBeDefined();
      expect(prDep!.target ?? null).toBeNull();

      // …and staging's production deployment is UNTOUCHED (still promoted,
      // still serving its own env).
      const prodDep = yield* observeDeployment(staging.prodDeploymentId);
      expect(prodDep).toBeDefined();
      expect(prodDep!.readyState).toEqual("READY");
      expect(prodDep!.readySubstate).toEqual("PROMOTED");

      // ── 3. Per-stage alias serves the PR tenant through the bypass
      //       (SSO-gated on team accounts), with ITS per-deployment env.
      const prBody = (yield* getJson(`${pr.url}/env`, bypass)) as {
        greeting: string | null;
      };
      expect(prBody.greeting).toEqual("pr-preview");

      // Per-deployment delivery, proven from both directions: the two
      // tenants see DIFFERENT values for the same key, and the key never
      // landed in shared project env.
      const envKeys = yield* projectEnvKeys(staging.projectId);
      expect(envKeys).not.toContain("GREETING");

      // ── 4. Identical redeploy: skip-on-hash keeps deployment AND alias.
      const redeployed = yield* deploy(PreviewStack, { stage: PR });
      expect(redeployed.deploymentId).toEqual(pr.deploymentId);
      expect(redeployed.alias.alias).toEqual(pr.alias.alias);

      // ── 5. The MANDATORY cross-tenant env conflict check: a tenant env
      //       key that exists in project env is a typed plan-time error
      //       (project env would silently shadow it).
      const conflicted = yield* Effect.result(
        deploy(ConflictStack, { stage: CONFLICT }),
      );
      expect(Result.isFailure(conflicted)).toBe(true);
      const conflictText = Result.isFailure(conflicted)
        ? describeFailure(conflicted.failure)
        : "";
      expect(
        conflictText.includes("TenantEnvConflict") ||
          conflictText.includes("already exist in shared project"),
      ).toBe(true);
      yield* destroy(ConflictStack, { stage: CONFLICT });

      // ── 6. PR stage destroy removes ONLY its alias + its meta-stamped
      //       deployments — the shared project and staging's production
      //       survive.
      yield* destroy(PreviewStack, { stage: PR });
      expect(yield* observeAlias(pr.alias.alias)).toBeUndefined();
      const prGone = yield* observeDeployment(pr.deploymentId).pipe(
        Effect.map((d) => d === undefined || d.readyState === "DELETED"),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
      expect(prGone).toBe(true);
      const prodStill = yield* observeDeployment(staging.prodDeploymentId);
      expect(prodStill).toBeDefined();
      expect(prodStill!.readyState).toEqual("READY");
      const prodBodyAfter = (yield* getJson(
        `${staging.prodUrl}/env`,
        bypass,
      )) as { greeting: string | null };
      expect(prodBodyAfter.greeting).toEqual("staging-production");

      // ── 7. Staging destroy REFUSES while its tenant production
      //       deployment is active — deleting it would brick the site, not
      //       roll it back (PROBES.md probe 1).
      const refused = yield* Effect.result(
        destroy(StagingStack, { stage: STAGING }),
      );
      expect(Result.isFailure(refused)).toBe(true);
      const refusedText = Result.isFailure(refused)
        ? describeFailure(refused.failure)
        : "";
      expect(
        refusedText.includes("TenantProductionDeleteRefused") ||
          refusedText.includes("refusing to delete deployment"),
      ).toBe(true);

      // ── 8. Teardown: retire the production deployment out-of-band (the
      //       shared project is going away), then the destroy proceeds —
      //       tenant rows drain and the Project delete cascades.
      yield* retireProduction(staging.projectId);
      yield* destroy(StagingStack, { stage: STAGING });
      yield* expectProjectGone(staging.projectId);
    }).pipe(Effect.ensuring(teardown), logLevel);
  },
  { timeout: 180_000 },
);
