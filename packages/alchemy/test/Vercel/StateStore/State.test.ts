/**
 * Live end-to-end test for the Vercel-hosted state store (DESIGN §13).
 *
 * This test OWNS the store's full lifecycle on the test team: it
 * bootstraps the state function (deployed by alchemy's own Vercel deploy
 * engine, with local state hoisted into the store), exercises the
 * StateService surface, deploys a tiny stack USING the store as its
 * state backend, verifies the rows out-of-band over the raw HTTP API,
 * destroys the stack (rows gone), proves the credential-loss recovery
 * path (re-bootstrap reads the token back from the `encrypted` project
 * env), and finally tears the store down — the state function is never
 * left deployed.
 *
 * Non-interactive by design: `bootstrap`/`teardownStateStore` are the
 * programmatic (CI) path; the interactive prompts live only in
 * `Vercel.state()`'s init and are not driven here.
 */
import * as Alchemy from "@/index.ts";
import { deploy } from "@/Deploy";
import { destroy } from "@/Destroy";
import { StateApi } from "@/State/HttpStateApi";
import { State } from "@/State/State";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import {
  STATE_STORE_PROJECT_NAME,
  STATE_STORE_VERSION,
} from "@/Vercel/StateStore/Api";
import {
  bootstrap,
  loginWithVercel,
  teardownStateStore,
} from "@/Vercel/StateStore/State";
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

/**
 * Credentials-file isolation: bootstrap/teardown write the cached
 * `{url, authToken}` under this dedicated profile so the test never
 * touches a real profile's state-store credentials.
 */
const TEST_PROFILE = "vercel-state-test";

const E2E_STACK = "VercelStateE2E";
const E2E_STAGE = "e2e";

const sampleState = (fqn: string, instanceId: string) => ({
  kind: "resource" as const,
  resourceType: "Test.Resource",
  namespace: undefined,
  fqn,
  logicalId: fqn.split("/").pop()!,
  instanceId,
  providerVersion: 1,
  status: "created" as const,
  downstream: [],
  bindings: [],
  props: { hello: "world" },
  attr: { id: instanceId },
});

/** Raw HTTP API client against the deployed store (out-of-band checks). */
const rawClient = (credentials: { url: string; authToken: string }) =>
  HttpApiClient.make(StateApi, {
    baseUrl: credentials.url,
    transformClient: HttpClient.mapRequest((req) =>
      HttpClientRequest.bearerToken(req, credentials.authToken),
    ),
  });

/** Poll (bounded) until the state project is gone. */
const expectProjectGone = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  const gone = yield* getProject({
    idOrName: STATE_STORE_PROJECT_NAME,
    teamId,
  }).pipe(
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

test.provider(
  "bootstrap → StateService surface → stack on Vercel state → destroy → recovery → teardown",
  () =>
    Effect.gen(function* () {
      // Clean slate: reclaim anything a previously crashed run left
      // behind (project, blob store, cached credentials, local stack).
      yield* teardownStateStore({ profile: TEST_PROFILE }).pipe(Effect.ignore);

      // ── 1. Bootstrap: our own engine deploys the store function +
      //       private blob store, then hoists the local bootstrap state
      //       into the store itself.
      const store = yield* bootstrap({ profile: TEST_PROFILE });
      expect(yield* store.getVersion()).toBe(STATE_STORE_VERSION);

      // ── 2. StateService surface against the live store.
      const fqn = "stack/scope/resource-a";
      yield* store.deleteStack({ stack: "probe" }).pipe(Effect.ignore);
      const echoed = yield* store.set({
        stack: "probe",
        stage: "s1",
        fqn,
        value: sampleState(fqn, "inst-a"),
      });
      expect(echoed.fqn).toBe(fqn);
      const got = yield* store.get({ stack: "probe", stage: "s1", fqn });
      expect(got).toBeDefined();
      expect((got as any).props).toEqual({ hello: "world" });
      expect([...(yield* store.list({ stack: "probe", stage: "s1" }))]).toEqual(
        [fqn],
      );
      expect([...(yield* store.listStacks())]).toContain("probe");
      expect([...(yield* store.listStages("probe"))]).toEqual(["s1"]);
      const out = yield* store.setOutput({
        stack: "probe",
        stage: "s1",
        value: { url: "https://example.com", count: 42 },
      });
      expect(out).toEqual({ url: "https://example.com", count: 42 });
      expect(yield* store.getOutput({ stack: "probe", stage: "s1" })).toEqual({
        url: "https://example.com",
        count: 42,
      });
      const missing = yield* store.get({
        stack: "probe",
        stage: "s1",
        fqn: "does/not/exist",
      });
      expect(missing).toBeUndefined();
      yield* store.delete({ stack: "probe", stage: "s1", fqn });
      expect(
        yield* store.get({ stack: "probe", stage: "s1", fqn }),
      ).toBeUndefined();
      yield* store.deleteStack({ stack: "probe" });
      expect([...(yield* store.listStacks())]).not.toContain("probe");

      // The bootstrap stack's own state was hoisted INTO the store.
      expect([...(yield* store.listStacks())]).toContain("VercelStateStore");

      // ── 3. A real stack deployed WITH the store as its state backend.
      const stateLayer = Layer.succeed(State, Effect.succeed(store));
      const E2EStack = Alchemy.Stack(
        E2E_STACK,
        { providers: Vercel.providers(), state: stateLayer },
        Effect.gen(function* () {
          const cfg = yield* Vercel.EdgeConfig("Cfg", {
            items: { greeting: "hello-from-vercel-state" },
          });
          return { edgeConfigId: cfg.edgeConfigId };
        }),
      );
      const output = yield* deploy({ stack: E2EStack, stage: E2E_STAGE }).pipe(
        Effect.provide(stateLayer),
      );
      expect(output.edgeConfigId).toBeDefined();

      // Out-of-band: the rows are visible over the raw HTTP API with the
      // bootstrap credentials.
      const credentials = yield* loginWithVercel(TEST_PROFILE, false);
      const client = yield* rawClient(credentials);
      const fqns = yield* client.state.listResources({
        params: { stack: E2E_STACK, stage: E2E_STAGE },
      });
      expect(fqns.length).toBeGreaterThan(0);
      expect(fqns.some((row) => row.includes("Cfg"))).toBe(true);
      const stackOutput = (yield* client.state.getStackOutput({
        params: { stack: E2E_STACK, stage: E2E_STAGE },
      })) as { edgeConfigId?: string } | undefined;
      expect(stackOutput?.edgeConfigId).toBe(output.edgeConfigId);

      // A bogus bearer is rejected.
      const unauthorized = yield* rawClient({
        url: credentials.url,
        authToken: "not-the-token",
      }).pipe(
        Effect.flatMap((bad) => bad.state.listStacks()),
        Effect.map(() => false),
        Effect.catch((e) =>
          Effect.succeed(
            String((e as { _tag?: string })._tag).startsWith("Unauthorized"),
          ),
        ),
      );
      expect(unauthorized).toBe(true);

      // ── 4. Destroy the stack — its rows disappear from the store.
      yield* destroy({ stack: E2EStack, stage: E2E_STAGE }).pipe(
        Effect.provide(stateLayer),
      );
      const remaining = yield* client.state.listResources({
        params: { stack: E2E_STACK, stage: E2E_STAGE },
      });
      expect([...remaining]).toEqual([]);

      // ── 5. Credential-loss recovery: a second bootstrap re-derives the
      //       bearer token out-of-band from the `encrypted` project env
      //       (loginWithVercel force-refresh) and adopts the store.
      const readopted = yield* bootstrap({ profile: TEST_PROFILE });
      expect(yield* readopted.getVersion()).toBe(STATE_STORE_VERSION);

      // ── 6. Teardown: project + blob store + credentials all gone.
      yield* teardownStateStore({ profile: TEST_PROFILE });
      yield* expectProjectGone;
      yield* expectStoreGone;
    }).pipe(logLevel),
  { timeout: 300_000 },
);
