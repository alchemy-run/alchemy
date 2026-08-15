/**
 * DEPTH chain 6 — adoption + drift healing (live, doppler alchemy-v2/dev).
 *
 * EdgeConfig + Function with EXPLICIT deterministic physical names (cold
 * reads look resources up by name, so auto-generated names — which embed a
 * per-instance random suffix — cannot be re-found after state loss).
 *
 * Cycles:
 *   1. greenfield deploy on the durable scratch state
 *   2. STATE LOSS — a second stack instance with the SAME stack name but a
 *      fresh in-memory state store:
 *        a. plan WITHOUT adopt → the Edge Config (unownable: Vercel has no
 *           tags) gates with `OwnedBySomeoneElse`
 *        b. deploy WITH `adopt(true)` → same physical ids (no recreation);
 *           the token — documented un-adoptable (plaintext disclosed once,
 *           lives only in state) — mints a successor, which is asserted
 *           honestly
 *   3. OUT-OF-BAND DRIFT — raw-API item tamper + foreign item + deleted
 *      managed env row → the next reconcile heals all three (converged
 *      values asserted out-of-band); sensitive row re-asserted per D5
 *      (write-only, fingerprint comment, runtime still serves the value)
 *   4. destroy through BOTH state stores — census-clean.
 */
import { adopt } from "@/AdoptPolicy";
import * as Core from "@/Test/Core.ts";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as globalConfig from "@distilled.cloud/vercel/global_config";
import {
  filterProjectEnvs,
  getProject,
  removeProjectEnv,
} from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const OPTIONS = {
  providers: Vercel.providers(),
} satisfies Test.MakeOptions;

const { test } = Test.make(OPTIONS);

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureMain = new URL("./fixtures/drift-fn.ts", import.meta.url).pathname;

// Deterministic (per-test-case constant) physical names — the whole point
// of the chain: cold reads after state loss must be able to find them.
const SLUG = "alchemy_chain_adopt_drift";
const FN_NAME = "alchemy-chain-adopt-drift-fn";

const ITEMS_V1 = { greeting: "drift-v1", rollout: 5 };
const ITEMS_HEAL = { greeting: "drift-v1", healed: true };
const SECRET = "drift-secret-one";

const program = (items: Record<string, unknown>, mode: string) =>
  Effect.gen(function* () {
    const flags = yield* Vercel.EdgeConfig("DriftFlags", {
      slug: SLUG,
      items: { ...items },
    });
    const token = yield* Vercel.EdgeConfigToken("DriftToken", {
      edgeConfigId: flags.edgeConfigId,
    });
    const fn = yield* Vercel.Function("DriftFn", {
      name: FN_NAME,
      main: fixtureMain,
      env: {
        FLAGS: token.connectionString,
        APP_MODE: mode,
        SECRET_VALUE: Redacted.make(SECRET),
      },
    });
    return { flags, token, fn };
  });

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

const getJsonUntil = <A>(url: string, until: (body: A) => boolean) =>
  getJson(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => until(body as A),
      times: 20,
    }),
    Effect.map((body) => body as A),
  );

const currentTeamId = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId;
});

/** Read the config's items out-of-band as a plain record. */
const fetchItems = (edgeConfigId: string) =>
  Effect.gen(function* () {
    const teamId = yield* currentTeamId;
    const items = yield* globalConfig.getEdgeConfigItems({
      edgeConfigId,
      teamId,
    });
    return Object.fromEntries(items.map((item) => [item.key, item.value]));
  });

const envRows = (projectId: string) =>
  Effect.gen(function* () {
    const teamId = yield* currentTeamId;
    const envs = yield* filterProjectEnvs({
      idOrName: projectId,
      teamId,
      decrypt: "true",
    });
    return (
      Array.isArray(envs)
        ? envs
        : typeof envs === "object" && envs !== null && "envs" in envs
          ? (envs as { envs: unknown[] }).envs
          : []
    ) as Array<{
      id?: string;
      key: string;
      type: string;
      value?: string;
      comment?: string;
    }>;
  });

/** Poll (bounded) until the project is gone. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const teamId = yield* currentTeamId;
    const gone = yield* getProject({ idOrName: projectId, teamId }).pipe(
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

/** Poll (bounded) until the Edge Config is gone (cascades its tokens). */
const expectEdgeConfigGone = (edgeConfigId: string) =>
  Effect.gen(function* () {
    const teamId = yield* currentTeamId;
    const gone = yield* globalConfig
      .getEdgeConfig({ edgeConfigId, teamId })
      .pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (g) => g,
          times: 8,
        }),
      );
    expect(gone).toBe(true);
  });

test.provider(
  "adoption after state loss reuses physical resources; out-of-band drift heals",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const teamId = yield* currentTeamId;

      // ── Cycle 1: greenfield on the durable scratch state ───────────────
      const c1 = yield* stack.deploy(program(ITEMS_V1, "a"));
      expect(c1.flags.edgeConfigId).toMatch(/^ecfg_/);
      expect(c1.flags.slug).toEqual(SLUG);
      expect(c1.fn.projectName).toEqual(FN_NAME);

      const flag1 = yield* getJsonUntil<{ value: unknown }>(
        `${c1.fn.url}/item/greeting`,
        (body) => body.value === ITEMS_V1.greeting,
      );
      expect(flag1.value).toEqual("drift-v1");
      const env1 = (yield* getJson(`${c1.fn.url}/env`)) as {
        appMode: string | null;
        secretValue: string | null;
      };
      expect(env1.appMode).toEqual("a");
      expect(env1.secretValue).toEqual(SECRET);

      const tokens1 = yield* globalConfig.getEdgeConfigTokens({
        edgeConfigId: c1.flags.edgeConfigId,
        teamId,
      });
      expect(tokens1.length).toEqual(1);

      // ── Cycle 2: state loss — same stack name, fresh in-memory state ───
      const fresh = Core.scratchStack(OPTIONS, stack.name);
      expect(fresh.name).toEqual(stack.name);

      // 2a. WITHOUT adopt: the plan's adoption probe finds the Edge Config
      //     by slug but cannot prove ownership (Vercel has no tags) —
      //     Unowned gates the takeover.
      const gated = yield* Effect.flip(fresh.plan(program(ITEMS_V1, "a")));
      expect(gated._tag).toEqual("OwnedBySomeoneElse");
      expect(String(gated.message)).toContain("Vercel.EdgeConfig");

      // 2b. WITH adopt: the deploy converges onto the SAME physical
      //     resources — no recreation.
      const adopted = yield* fresh.deploy(
        program(ITEMS_V1, "a").pipe(adopt(true)),
      );
      expect(adopted.flags.edgeConfigId).toEqual(c1.flags.edgeConfigId);
      expect(adopted.fn.projectId).toEqual(c1.fn.projectId);
      expect(adopted.fn.projectName).toEqual(FN_NAME);
      // The declared items were untouched by adoption (still v1).
      expect(yield* fetchItems(c1.flags.edgeConfigId)).toEqual(ITEMS_V1);

      // HONEST pin of the documented un-adoptable resource: the read
      // token's plaintext lives only in state (Vercel discloses it once),
      // so state loss forces a successor mint — the original token remains
      // until the config cascade removes it.
      const tokens2 = yield* globalConfig.getEdgeConfigTokens({
        edgeConfigId: c1.flags.edgeConfigId,
        teamId,
      });
      expect(tokens2.length).toEqual(2);
      expect(adopted.token.tokenId).not.toEqual(tokens1[0]!.id);
      // The FLAGS row rotated to the successor token ⇒ a new deployment
      // (env only takes effect on new deployments) that still serves reads.
      const flagAdopted = yield* getJsonUntil<{ value: unknown }>(
        `${adopted.fn.url}/item/greeting`,
        (body) => body.value === ITEMS_V1.greeting,
      );
      expect(flagAdopted.value).toEqual("drift-v1");

      // ── Cycle 3: out-of-band drift → reconcile heals ───────────────────
      // (a) Tamper a managed item + plant a foreign one.
      yield* globalConfig.patchEdgeConfigItems({
        edgeConfigId: c1.flags.edgeConfigId,
        teamId,
        items: [
          { operation: "upsert", key: "greeting", value: "tampered" },
          { operation: "upsert", key: "intruder", value: "foreign" },
        ],
      });
      // (b) Delete a managed env row (the observable drift class — value
      //     tampering on encrypted rows is undetectable by design, see D5).
      const rowsDrift = yield* envRows(c1.fn.projectId);
      const appModeRow = rowsDrift.find((r) => r.key === "APP_MODE");
      expect(appModeRow?.id).toBeDefined();
      yield* removeProjectEnv({
        idOrName: c1.fn.projectId,
        id: appModeRow!.id!,
        teamId,
      });

      // Reconcile with a declared change on BOTH resources (identical
      // declarations short-circuit at plan time — reconcile only runs when
      // props differ).
      const healed = yield* fresh.deploy(program(ITEMS_HEAL, "b"));
      // STABLE: physical identities.
      expect(healed.flags.edgeConfigId).toEqual(c1.flags.edgeConfigId);
      expect(healed.fn.projectId).toEqual(c1.fn.projectId);
      // CHANGED/HEALED: items converged to the declaration — tampered value
      // reverted, foreign key removed, declared change applied.
      expect(yield* fetchItems(c1.flags.edgeConfigId)).toEqual(ITEMS_HEAL);
      // The deleted managed row was re-created with the declared value.
      const rowsHealed = yield* envRows(c1.fn.projectId);
      const appModeHealed = rowsHealed.find((r) => r.key === "APP_MODE");
      expect(appModeHealed).toBeDefined();
      // D5 re-assertion: the sensitive row is still write-only with its
      // fingerprint comment, and the redeployed runtime serves both the
      // healed env and the unchanged secret.
      const secretRow = rowsHealed.find((r) => r.key === "SECRET_VALUE");
      expect(secretRow).toBeDefined();
      expect(secretRow!.type).toEqual("sensitive");
      expect(secretRow!.value).toEqual("");
      expect(secretRow!.comment).toMatch(/^alchemy:sha256:/);
      const envHealed = yield* getJsonUntil<{
        appMode: string | null;
        secretValue: string | null;
      }>(`${healed.fn.url}/env`, (body) => body.appMode === "b");
      expect(envHealed.appMode).toEqual("b");
      expect(envHealed.secretValue).toEqual(SECRET);
      const flagHealed = yield* getJsonUntil<{ value: unknown }>(
        `${healed.fn.url}/item/greeting`,
        (body) => body.value === "drift-v1",
      );
      expect(flagHealed.value).toEqual("drift-v1");

      // ── Cycle 4: destroy through BOTH stores — census-clean ────────────
      // `fresh` owns the current rows (successor token included); the
      // original durable scratch still tracks cycle-1's rows against the
      // same physical resources — both destroys are idempotent.
      yield* fresh.destroy();
      yield* stack.destroy();
      yield* expectEdgeConfigGone(c1.flags.edgeConfigId);
      yield* expectProjectGone(c1.fn.projectId);
    }).pipe(logLevel),
  // Three deploy cycles (greenfield, adopt, heal) + a gated plan over a
  // real Function — justified above the 120s single-resource budget.
  { timeout: 360_000 },
);
