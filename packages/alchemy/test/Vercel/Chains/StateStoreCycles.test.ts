/**
 * DEPTH chain 8 — self-hosted state cycles: a real resource chain
 * (EdgeConfig + EdgeConfigToken + Function binding it via connection
 * string) whose stack state lives in the self-hosted Vercel state store,
 * driven through multiple reconciliation cycles while the state rows are
 * observed OUT-OF-BAND over the store's raw HTTP API.
 *
 * Cycle map:
 *   bootstrap        → store deployed, /version pinned over raw HTTP
 *   cycle 1 (deploy) → rows for every chain resource appear; stack output
 *                      row matches; the fn serves the bound item
 *   cycle 2 (no-op)  → deploymentId / edgeConfigId / tokenId stable AND
 *                      the persisted rows are byte-identical
 *   cycle 3 (mutate) → EdgeConfig items change: ONLY the EdgeConfig row's
 *                      content changes (digest moves), fn + token rows and
 *                      deploymentId stay stable (data-plane-only update)
 *   destroy          → rows vanish from the store; cloud resources gone
 *   recovery         → credentials file deleted; loginWithVercel re-derives
 *                      the bearer from the encrypted project env
 *   teardown         → state project + blob store gone (census clean)
 *
 * NOTE ON ISOLATION: the state-store project name is a process-global
 * constant (`STATE_STORE_PROJECT_NAME`, override via
 * `ALCHEMY_VERCEL_STATE_PROJECT` before process start), so this suite and
 * `test/Vercel/StateStore/State.test.ts` necessarily target the same
 * physical store name when run in one process. This test takes the
 * whole-process write lock (`exclusive: true`) so it can never interleave
 * with that suite (both own bootstrap/teardown of the store). Credentials
 * are isolated under a dedicated profile either way.
 *
 * The lock does NOT protect against a SECOND runner process executing
 * this file (or State.test.ts) concurrently — the store is a
 * team-singleton, and two owners sabotage each other (one side's
 * teardown/bootstrap makes the other's rows invisible mid-deploy; its
 * greenfield re-create then leaks a full second generation — observed
 * live, see the 2026-08-14 blob-consistency rows in
 * processes/Vercel/PROBES.md). Never run two processes over this suite
 * at once.
 */
import { CredentialsStore } from "@/Auth/Credentials";
import { deploy } from "@/Deploy";
import { destroy } from "@/Destroy";
import * as Alchemy from "@/index.ts";
import { StateApi } from "@/State/HttpStateApi";
import { State } from "@/State/State";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import {
  STATE_STORE_PROJECT_NAME,
  STATE_STORE_VERSION,
} from "@/Vercel/StateStore/Api";
import { CREDENTIALS_FILE } from "@/Vercel/StateStore/CredentialsFile";
import {
  bootstrap,
  loginWithVercel,
  teardownStateStore,
} from "@/Vercel/StateStore/State";
import * as globalConfig from "@distilled.cloud/vercel/global_config";
import { getProject } from "@distilled.cloud/vercel/projects";
import { getStorageStores } from "@distilled.cloud/vercel/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/** Dedicated credentials profile — never touches another suite's cache. */
const PROFILE = "vercel-state-cycles";

const STACK = "VercelStateCycles";
const STAGE = "cycles";

const ITEMS_V1 = { greeting: "cycles-v1", flag: true };
const ITEMS_V2 = { greeting: "cycles-v2", flag: true, extra: [1, 2] };

const fixtureMain = new URL("./fixtures/state-cycles-fn.ts", import.meta.url)
  .pathname;

/** Raw HTTP API client against the deployed store (out-of-band checks). */
const rawClient = (credentials: { url: string; authToken: string }) =>
  HttpApiClient.make(StateApi, {
    baseUrl: credentials.url,
    transformClient: HttpClient.mapRequest((req) =>
      HttpClientRequest.bearerToken(req, credentials.authToken),
    ),
  });

/** Fetch one JSON body with first-request readiness retries (bounded). */
const getJsonUntil = <A>(url: string, until: (body: A) => boolean) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`status ${response.status}`)),
    ),
    Effect.retry({
      schedule: Schedule.exponential("500 millis"),
      times: 10,
    }),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => until(body as A),
      times: 15,
    }),
    Effect.map((body) => body as A),
  );

/** Poll (bounded, typed) until a project is gone. */
const expectProjectGone = (idOrName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* getProject({ idOrName, teamId }).pipe(
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

/** Poll (bounded, typed) until the Edge Config is gone. */
const expectEdgeConfigGone = (edgeConfigId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
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

/** The state blob store must be gone from the team listing. */
const expectStoreGone = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  const gone = yield* getStorageStores({ teamId }).pipe(
    Effect.map(
      ({ stores }) =>
        !stores.some(
          (row) => row.type === "blob" && row.name === STATE_STORE_PROJECT_NAME,
        ),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (g) => g,
      times: 10,
    }),
  );
  expect(gone).toBe(true);
});

/** Persisted state-row shape (only the fields the chain asserts on). */
interface StateRow {
  readonly resourceType?: string;
  readonly status?: string;
  readonly props?: { items?: Record<string, unknown> };
  readonly attr?: Record<string, unknown>;
}

test.provider(
  "state cycles: bootstrap → deploy chain → no-op → mutate → destroy → recovery → teardown",
  () => {
    // Failure-path cleanup: a mid-body failure must still destroy the
    // chain (which needs the store alive) and then tear the store down —
    // the harness's scratch-stack auto-teardown does not cover stacks
    // deployed with a custom state layer. Set once the store exists;
    // `finished` skips the duplicate work on the happy path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the
    // destroy effect's leftover requirements are satisfied by the test
    // harness context the ensuring runs in.
    let destroyChain: Effect.Effect<void, never, any> | undefined;
    let finished = false;
    return Effect.gen(function* () {
      // Clean slate: reclaim whatever a previously crashed run left behind
      // (store project, blob store, cached credentials, local stack).
      yield* teardownStateStore({ profile: PROFILE }).pipe(Effect.ignore);

      // ── Bootstrap the self-hosted store.
      const store = yield* bootstrap({ profile: PROFILE });

      // /version honored — both through the StateService surface and the
      // raw unauthenticated HTTP route.
      expect(yield* store.getVersion()).toBe(STATE_STORE_VERSION);
      const credentials = yield* loginWithVercel(PROFILE, false);
      const client = yield* rawClient(credentials);
      const version = yield* client.version.getVersion();
      expect(version.version).toBe(STATE_STORE_VERSION);

      const stateLayer = Layer.succeed(State, Effect.succeed(store));

      /** The chain under test — items parametrized per cycle. */
      const makeStack = (items: Record<string, unknown>) =>
        Alchemy.Stack(
          STACK,
          { providers: Vercel.providers(), state: stateLayer },
          Effect.gen(function* () {
            const flags = yield* Vercel.EdgeConfig("CyclesFlags", { items });
            const token = yield* Vercel.EdgeConfigToken("CyclesToken", {
              edgeConfigId: flags.edgeConfigId,
            });
            const fn = yield* Vercel.Function("CyclesFn", {
              main: fixtureMain,
              env: {
                // binding-as-env-value form: Redacted attribute Output ⇒
                // synced as a sensitive env var on the function's project.
                FLAGS: token.connectionString,
              },
            });
            return {
              edgeConfigId: flags.edgeConfigId,
              digest: flags.digest,
              tokenId: token.tokenId,
              projectId: fn.projectId,
              deploymentId: fn.deploymentId,
              url: fn.url,
            };
          }),
        );

      destroyChain = destroy({
        stack: makeStack(ITEMS_V2),
        stage: STAGE,
      }).pipe(Effect.provide(stateLayer), Effect.ignore);

      const readRow = (fqn: string) =>
        client.state
          .getState({
            params: {
              stack: STACK,
              stage: STAGE,
              fqn: encodeURIComponent(fqn),
            },
          })
          .pipe(Effect.map((row) => row as StateRow | undefined));

      const listRows = client.state
        .listResources({ params: { stack: STACK, stage: STAGE } })
        .pipe(Effect.map((rows) => [...rows]));

      // ── Cycle 1: greenfield deploy of the chain, state on Vercel.
      const c1 = yield* deploy({
        stack: makeStack(ITEMS_V1),
        stage: STAGE,
      }).pipe(Effect.provide(stateLayer));
      expect(c1.edgeConfigId).toMatch(/^ecfg_/);
      expect(c1.deploymentId).toBeDefined();
      expect(c1.url).toBeDefined();

      // Rows for every chain resource exist in the store, out-of-band.
      const fqns1 = yield* listRows;
      const fqnOf = (logicalId: string) => {
        const fqn = fqns1.find((row) => row.includes(logicalId));
        expect(fqn).toBeDefined();
        return fqn!;
      };
      const flagsFqn = fqnOf("CyclesFlags");
      const tokenFqn = fqnOf("CyclesToken");
      const fnFqn = fqnOf("CyclesFn");

      // The stack-output row round-trips the deploy outputs.
      const out1 = (yield* client.state.getStackOutput({
        params: { stack: STACK, stage: STAGE },
      })) as typeof c1 | undefined;
      expect(out1?.edgeConfigId).toBe(c1.edgeConfigId);
      expect(out1?.deploymentId).toBe(c1.deploymentId);

      // Row content: the EdgeConfig row persists the V1 desired items.
      const flagsRow1 = yield* readRow(flagsFqn);
      expect(flagsRow1?.status).toBe("created");
      expect(flagsRow1?.props?.items).toEqual(ITEMS_V1);
      const fnRow1 = yield* readRow(fnFqn);
      expect(fnRow1).toBeDefined();
      const tokenRow1 = yield* readRow(tokenFqn);
      expect(tokenRow1).toBeDefined();

      // The chain actually works: the fn serves the bound item.
      const served1 = yield* getJsonUntil<{ value: unknown }>(
        `${c1.url}/item/greeting`,
        (body) => body.value === ITEMS_V1.greeting,
      );
      expect(served1.value).toBe(ITEMS_V1.greeting);

      // ── Cycle 2: identical redeploy — a no-op end to end.
      const c2 = yield* deploy({
        stack: makeStack(ITEMS_V1),
        stage: STAGE,
      }).pipe(Effect.provide(stateLayer));
      // Stable: every physical identity survives untouched.
      expect(c2.edgeConfigId).toBe(c1.edgeConfigId);
      expect(c2.tokenId).toBe(c1.tokenId);
      expect(c2.projectId).toBe(c1.projectId);
      expect(c2.deploymentId).toBe(c1.deploymentId);
      expect(c2.digest).toBe(c1.digest);
      // Stable: the persisted rows did not change at all.
      expect(yield* readRow(flagsFqn)).toEqual(flagsRow1);
      expect(yield* readRow(fnFqn)).toEqual(fnRow1);
      expect(yield* readRow(tokenFqn)).toEqual(tokenRow1);
      expect((yield* listRows).sort()).toEqual([...fqns1].sort());

      // ── Cycle 3: mutate the EdgeConfig items (data-plane-only change).
      const c3 = yield* deploy({
        stack: makeStack(ITEMS_V2),
        stage: STAGE,
      }).pipe(Effect.provide(stateLayer));
      // Stable: nothing about the function or token was touched.
      expect(c3.edgeConfigId).toBe(c1.edgeConfigId);
      expect(c3.tokenId).toBe(c1.tokenId);
      expect(c3.projectId).toBe(c1.projectId);
      expect(c3.deploymentId).toBe(c1.deploymentId);
      // Changed: the config content moved (digest is content-addressed).
      expect(c3.digest).not.toBe(c1.digest);
      // Changed: ONLY the EdgeConfig row's content changed in the store.
      const flagsRow3 = yield* readRow(flagsFqn);
      expect(flagsRow3?.props?.items).toEqual(ITEMS_V2);
      expect(flagsRow3).not.toEqual(flagsRow1);
      // Stable: sibling rows byte-identical.
      expect(yield* readRow(fnFqn)).toEqual(fnRow1);
      expect(yield* readRow(tokenFqn)).toEqual(tokenRow1);
      // The mutation propagated to the served data plane.
      const served3 = yield* getJsonUntil<{ value: unknown }>(
        `${c1.url}/item/greeting`,
        (body) => body.value === ITEMS_V2.greeting,
      );
      expect(served3.value).toBe(ITEMS_V2.greeting);

      // ── Destroy: rows vanish from the store; cloud resources gone.
      yield* destroy({
        stack: makeStack(ITEMS_V2),
        stage: STAGE,
      }).pipe(Effect.provide(stateLayer));
      expect(yield* listRows).toEqual([]);
      expect(yield* readRow(flagsFqn)).toBeUndefined();
      yield* expectEdgeConfigGone(c1.edgeConfigId);
      yield* expectProjectGone(c1.projectId);

      // ── Credential-loss recovery: drop the cached credentials file and
      //    re-derive the bearer token out-of-band from the state project's
      //    `encrypted` env row.
      const credStore = yield* CredentialsStore;
      yield* credStore.delete(PROFILE, CREDENTIALS_FILE);
      const recovered = yield* loginWithVercel(PROFILE, true);
      expect(recovered.url).toBe(credentials.url);
      expect(recovered.authToken).toBe(credentials.authToken);
      const recoveredClient = yield* rawClient(recovered);
      const stacks = yield* recoveredClient.state.listStacks();
      expect([...stacks]).toContain("VercelStateStore");

      // ── Teardown: state project + blob store gone — census clean.
      yield* teardownStateStore({ profile: PROFILE });
      yield* expectProjectGone(STATE_STORE_PROJECT_NAME);
      yield* expectStoreGone;
      finished = true;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          finished
            ? Effect.void
            : (destroyChain ?? Effect.void).pipe(
                Effect.andThen(
                  teardownStateStore({ profile: PROFILE }).pipe(Effect.ignore),
                ),
              ),
        ),
      ),
      logLevel,
    );
  },
  { timeout: 420_000, exclusive: true },
);
