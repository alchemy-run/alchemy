/**
 * Vercel Alias lifecycle + promote/rollback action tests — live against the
 * standing Vercel test team (run with the doppler alchemy-v2/dev env).
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as aliases from "@distilled.cloud/vercel/aliases";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureMain = new URL("./fixtures/handler.ts", import.meta.url).pathname;

// Deterministic alias names — constant across runs (global .vercel.app
// namespace, owned by the standing test team after the first run).
const STABLE_ALIAS = "alchemy-vrc-alias-e2e.vercel.app";

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
    // always retry the first request (bounded, ~15s worst case).
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 15 }),
  );

/** Poll (bounded) an URL until it reports the expected fixture version. */
const expectVersion = (url: string, version: string, bypass?: string) =>
  Effect.gen(function* () {
    const body = (yield* getJson(url, bypass).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (b) => (b as { version: string | null }).version === version,
        times: 20,
      }),
    )) as { version: string | null };
    expect(body.version).toEqual(version);
  });

/**
 * Mint an automation bypass secret on the project (PROBES.md: `.vercel.app`
 * deployment aliases are SSO-gated on team accounts — only the auto-assigned
 * production domain is public — and the secret only opens deployments
 * created AFTER it was minted, so mint it before the deployments under
 * test).
 */
const mintBypassSecret = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const response = yield* projects.updateProjectProtectionBypass({
      idOrName: projectId,
      teamId,
      generate: { note: "alias e2e" },
    });
    const secret = Object.keys(response.protectionBypass ?? {})[0];
    expect(secret).toBeDefined();
    return secret!;
  });

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

/** Out-of-band alias observation via distilled (undefined = gone). */
const observeAlias = (aliasName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    return yield* aliases
      .getAlias({ idOrAlias: aliasName, teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  });

const makeFn = (version: string) =>
  Effect.gen(function* () {
    return yield* Vercel.Function("Fn", {
      main: fixtureMain,
      env: { VERSION: version },
    });
  });

test.provider(
  "alias a stable name to v1, re-point to v2, remove — alias gone, function intact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // 1. Bootstrap deploy (v0) to create the project, then mint the
      //    bypass secret — it only opens deployments created after it.
      const v0 = yield* stack.deploy(makeFn("v0"));
      const bypass = yield* mintBypassSecret(v0.projectId);

      // 2. Two retained deployments minted after the secret: v1, then v2
      //    (env change forces a new immutable deployment; v1 stays
      //    retained — no pruning).
      const v1 = yield* stack.deploy(makeFn("v1"));
      const d1 = v1.deploymentId;
      const v2 = yield* stack.deploy(makeFn("v2"));
      const d2 = v2.deploymentId;
      expect(d2).not.toEqual(d1);
      expect(d1).not.toEqual(v0.deploymentId);
      // Production alias now serves v2.
      yield* expectVersion(`${v2.url}/`, "v2");

      // 3. Alias the stable name to the OLD deployment (v1).
      const makeStack = (deployment: string) =>
        Effect.gen(function* () {
          const fn = yield* makeFn("v2");
          const alias = yield* Vercel.Alias("Stable", {
            alias: STABLE_ALIAS,
            deployment,
          });
          return { fn, alias };
        });
      const step1 = yield* stack.deploy(makeStack(d1));
      expect(step1.alias.alias).toEqual(STABLE_ALIAS);
      expect(step1.alias.uid).toBeDefined();
      expect(step1.alias.deploymentId).toEqual(d1);
      expect(step1.alias.url).toEqual(`https://${STABLE_ALIAS}`);
      // The function's own deployment was untouched (hash skip).
      expect(step1.fn.deploymentId).toEqual(d2);
      // The alias serves v1 while production serves v2. `.vercel.app`
      // deployment aliases are SSO-gated on team accounts — send the
      // bypass secret (both d1/d2 were minted after it).
      yield* expectVersion(`${step1.alias.url}/`, "v1", bypass);
      yield* expectVersion(`${step1.fn.url}/`, "v2");

      // 4. Re-point the alias at v2 (assign is an upsert — same alias row).
      const step2 = yield* stack.deploy(makeStack(d2));
      expect(step2.alias.deploymentId).toEqual(d2);
      yield* expectVersion(`${step2.alias.url}/`, "v2", bypass);

      // 5. Idempotent re-deploy: no-op (alias already points at d2).
      const step3 = yield* stack.deploy(makeStack(d2));
      expect(step3.alias.deploymentId).toEqual(d2);

      // 6. Remove the Alias from the stack — orphan delete. The alias is
      //    gone; the function (and its production alias) keeps serving.
      const step4 = yield* stack.deploy(makeFn("v2"));
      const observed = yield* observeAlias(STABLE_ALIAS);
      expect(observed).toBeUndefined();
      yield* expectVersion(`${step4.url}/`, "v2");

      // 7. Destroy cascades the owned project; typed wait-until-gone.
      yield* stack.destroy();
      yield* expectProjectGone(v1.projectId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "rollback production to the older deployment, then promote back",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const v1 = yield* stack.deploy(makeFn("v1"));
      const d1 = v1.deploymentId;
      const v2 = yield* stack.deploy(makeFn("v2"));
      const d2 = v2.deploymentId;
      expect(d2).not.toEqual(d1);
      const productionUrl = v2.url!;
      yield* expectVersion(`${productionUrl}/`, "v2");

      // Rollback: production re-points to the retained v1 deployment —
      // a pure traffic operation, no rebuild.
      yield* Vercel.rollbackProduction(v2.projectId, d1, {
        description: "alias e2e rollback",
      });
      yield* expectVersion(`${productionUrl}/`, "v1");

      // Promote back to v2.
      yield* Vercel.promoteToProduction(v2.projectId, d2);
      yield* expectVersion(`${productionUrl}/`, "v2");

      yield* stack.destroy();
      yield* expectProjectGone(v2.projectId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
