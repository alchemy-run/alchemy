import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Deploy from "@/Deploy.ts";
import { Random, RandomProvider } from "@/Random.ts";
import { Stack } from "@/Stack.ts";
import {
  inMemoryState,
  State,
  isResourceState,
  type PersistedState,
  type ResourceState,
  type StateService,
  StateStoreError,
} from "@/State";
import {
  BearerTokenValidator,
  StateApi,
  StateAuthLive,
  STATE_STORE_VERSION,
  StateStoreFailure,
} from "@/State/HttpStateApi.ts";
import { makeHttpStateStore } from "@/State/HttpStateStore.ts";
import { makeLocalState } from "@/State/LocalState.ts";
import { encodeState } from "@/State/StateEncoding.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";

const AUTH_TOKEN = "http-state-integration-test-token";
const STACK = "http-random-integration";
const STAGE = "test";
const SECRET_CONFIG = "HTTP_RANDOM_MIGRATION_KEY";
const { test } = Test.make({ providers: RandomProvider() });

const randomStack = (store: StateService, stackName = STACK) =>
  Stack(
    stackName,
    {
      providers: RandomProvider(),
      state: Layer.succeed(State, State.of(Effect.succeed(store))),
    },
    Random("migrated-random", { initial: Config.Redacted(SECRET_CONFIG) }),
  );

const state = <A>(
  operation: string,
  effect: (store: StateService) => Effect.Effect<A, StateStoreError>,
) =>
  Effect.flatMap(State, (get) => Effect.flatMap(get, effect)).pipe(
    Effect.mapError(
      (error) =>
        new StateStoreFailure({
          operation,
          reason: error instanceof Error ? error.name : "StateStoreError",
        }),
    ),
  );

const stateRoutes = HttpApiBuilder.group(StateApi, "state", (handlers) =>
  handlers
    .handle("listStacks", () => state("listStacks", (s) => s.listStacks()))
    .handle("listStages", ({ params }) => state("listStages", (s) => s.listStages(params.stack)))
    .handle("listResources", ({ params }) => state("listResources", (s) => s.list(params)))
    .handle("getState", ({ params }) =>
      state("getState", (s) => s.get({ ...params, fqn: decodeURIComponent(params.fqn) })).pipe(
        Effect.map((saved) => (saved === undefined ? undefined : encodeState(saved))),
      ),
    )
    .handle("setState", ({ params, payload }) =>
      state("setState", (s) =>
        s.set({
          ...params,
          fqn: decodeURIComponent(params.fqn),
          value: payload as PersistedState,
        }),
      ),
    )
    .handle("deleteState", ({ params }) =>
      state("deleteState", (s) => s.delete({ ...params, fqn: decodeURIComponent(params.fqn) })),
    )
    .handle("deleteStack", ({ params, query }) =>
      state("deleteStack", (s) => s.deleteStack({ stack: params.stack, ...query })),
    )
    .handle("getReplacedResources", ({ params }) =>
      state("getReplacedResources", (s) => s.getReplacedResources(params)).pipe(
        Effect.map((rows) => rows.map(encodeState)),
      ),
    )
    .handle("getStackOutput", ({ params }) =>
      state("getStackOutput", (s) => s.getOutput(params)).pipe(
        Effect.map((saved) => (saved === undefined ? undefined : encodeState(saved))),
      ),
    )
    .handle("setStackOutput", ({ params, payload }) =>
      state("setStackOutput", (s) => s.setOutput({ ...params, value: payload })),
    ),
);

const versionRoutes = HttpApiBuilder.group(StateApi, "version", (handlers) =>
  handlers.handle("getVersion", () => Effect.succeed({ version: STATE_STORE_VERSION })),
);

const server = (
  persisted: Record<string, Record<string, Record<string, ResourceState>>>,
  outputs: Record<string, Record<string, unknown>>,
  physicalStore?: StateService,
) => {
  const source: Layer.Layer<State> = physicalStore
    ? Layer.succeed(State, State.of(Effect.succeed(physicalStore)))
    : inMemoryState(persisted, outputs);
  // Assemble the API with all of its handler services before handing it to
  // HttpRouter.serve; deferred route requirements must not leak to callers.
  const api = HttpApiBuilder.layer(StateApi).pipe(
    Layer.provide(stateRoutes),
    Layer.provide(versionRoutes),
    Layer.provide(StateAuthLive),
    Layer.provide(
      Layer.succeed(BearerTokenValidator, {
        validate: (token) =>
          token === AUTH_TOKEN ? Effect.void : HttpApiError.Unauthorized.make({}),
      }),
    ),
    Layer.provide(source),
  );
  return HttpRouter.serve(api, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })));
};

const withServer = <A, E, R>(
  persisted: Record<string, Record<string, Record<string, ResourceState>>>,
  outputs: Record<string, Record<string, unknown>>,
  run: (url: string) => Effect.Effect<A, E, R>,
  physicalStore?: StateService,
) =>
  Effect.gen(function* () {
    const listener = yield* HttpServer.HttpServer;
    const url = HttpServer.formatAddress(listener.address);
    return yield* run(url);
  }).pipe(
    Effect.provide(server(persisted, outputs, physicalStore)),
    Effect.provide(FetchHttpClient.layer),
    Effect.scoped,
  );

describe("Random secret persisted over real HTTP state API", { tags: ["unit", "local"] }, () => {
  test(
    "survives client and server restart with a Redacted value and no bootstrap prop",
    Effect.suspend(() => {
      const persisted: Record<string, Record<string, Record<string, ResourceState>>> = {};
      const outputs: Record<string, Record<string, unknown>> = {};
      const secret = "ORIGINAL_HTTP_RANDOM_ENCRYPTION_KEY";
      const fqn = "migrated-random";

      return Effect.gen(function* () {
        yield* withServer(persisted, outputs, (url) =>
          Effect.gen(function* () {
            const store = yield* makeHttpStateStore({
              url,
              authToken: AUTH_TOKEN,
              id: "http",
            });
            expect(yield* store.getVersion()).toBe(STATE_STORE_VERSION);
            const actual = yield* Deploy.deploy({ stack: randomStack(store), stage: STAGE }).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnv({ env: { [SECRET_CONFIG]: secret } }),
              ),
            );
            expect(Redacted.value(actual.text)).toBe(secret);
            const created = yield* store.get({ stack: STACK, stage: STAGE, fqn });
            if (!isResourceState(created)) return yield* Effect.die("Missing Random state");
            expect(created.status).toBe("created");
            expect(created.props?.initial).toBeUndefined();
            const createdText = (created.attr as { text: Redacted.Redacted<string> }).text;
            expect(Redacted.value(createdText)).toBe(secret);
            const firstOutput = yield* store.getOutput({ stack: STACK, stage: STAGE });
            expect(Redacted.value((firstOutput as { text: Redacted.Redacted<string> }).text)).toBe(
              secret,
            );
          }),
        );

        // A distinct HTTP server and client, sharing only durable backing state.
        yield* withServer(persisted, outputs, (url) =>
          Effect.gen(function* () {
            const store = yield* makeHttpStateStore({ url, authToken: AUTH_TOKEN, id: "http" });
            const recovered = yield* Deploy.deploy({
              stack: randomStack(store),
              stage: STAGE,
            }).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnv({ env: {} }),
              ),
            );
            expect(Redacted.value(recovered.text)).toBe(secret);
            const restored = yield* store.get({ stack: STACK, stage: STAGE, fqn });
            if (!isResourceState(restored)) return yield* Effect.die("Missing Random state");
            expect(restored.status).toBe("created");
            expect(restored.props?.initial).toBeUndefined();
            const text = (restored.attr as { text: Redacted.Redacted<string> }).text;
            expect(Redacted.isRedacted(text)).toBe(true);
            expect(Redacted.value(text)).toBe(secret);
            const output = yield* store.getOutput({ stack: STACK, stage: STAGE });
            expect(Redacted.value((output as { text: Redacted.Redacted<string> }).text)).toBe(
              secret,
            );
            expect(yield* store.getReplacedResources({ stack: STACK, stage: STAGE })).toEqual([]);

            // Simulate a corrupted persisted HTTP row after a successful
            // restart. The engine must refuse to rotate the original secret.
            const resourceRow = persisted[STACK]?.[STAGE]?.[fqn];
            if (resourceRow === undefined) return yield* Effect.die("Missing persisted state row");
            persisted[STACK]![STAGE]![fqn] = {
              ...resourceRow,
              attr: { text: { __redacted__: 42 } },
            };
            const malformed = yield* Effect.result(
              Deploy.deploy({ stack: randomStack(store), stage: STAGE }).pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnv({ env: {} }),
                ),
              ),
            );
            expect(Result.isFailure(malformed)).toBe(true);
            if (Result.isFailure(malformed)) {
              expect(malformed.failure._tag).toBe("InvalidRandomState");
              expect(JSON.stringify(malformed.failure)).not.toContain(secret);
            }
            expect(persisted[STACK]?.[STAGE]?.[fqn]?.attr?.text).toEqual({
              __redacted__: 42,
            });

            persisted[STACK]![STAGE]![fqn] = resourceRow;
            const stable = yield* Deploy.deploy({ stack: randomStack(store), stage: STAGE }).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnv({ env: {} }),
              ),
            );
            expect(Redacted.value(stable.text)).toBe(secret);

            const untrusted = yield* makeHttpStateStore({
              url,
              authToken: "unauthorized-test-token",
              id: "http",
            });
            const unauthorized = yield* Effect.result(
              untrusted.get({ stack: STACK, stage: STAGE, fqn }),
            );
            expect(Result.isFailure(unauthorized)).toBe(true);
            if (Result.isFailure(unauthorized)) {
              expect(unauthorized.failure._tag).toBe("StateStoreError");
              expect(JSON.stringify(unauthorized.failure)).not.toContain(secret);
            }

            yield* store.deleteStack({ stack: STACK });
            expect(yield* store.get({ stack: STACK, stage: STAGE, fqn })).toBeUndefined();
          }),
        );
      });
    }),
  );

  test(
    "survives an HTTP server restart backed by independently reopened on-disk state",
    Effect.gen(function* () {
      const stackName = "http-random-disk-persistence-test";
      const expected = "IMPORTED_DISK_BACKED_HTTP_KEY";
      const firstStore = yield* makeLocalState();
      // This name is reserved for this test; clear an interrupted prior run
      // without touching other stacks or the user's deployment state.
      yield* firstStore.deleteStack({ stack: stackName });

      yield* withServer(
        {},
        {},
        (url) =>
          Effect.gen(function* () {
            const client = yield* makeHttpStateStore({ url, authToken: AUTH_TOKEN, id: "http" });
            const first = yield* Deploy.deploy({
              stack: randomStack(client, stackName),
              stage: STAGE,
            }).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnv({ env: { [SECRET_CONFIG]: expected } }),
              ),
            );
            expect(Redacted.value(first.text)).toBe(expected);
            const stored = yield* client.get({
              stack: stackName,
              stage: STAGE,
              fqn: "migrated-random",
            });
            if (!isResourceState(stored)) return yield* Effect.die("First HTTP disk state missing");
            expect(stored.props?.initial).toBeUndefined();
          }),
        firstStore,
      );

      // No in-memory backing object is carried between these HTTP servers:
      // this is a genuinely new StateService re-reading actual JSON files.
      const reopenedStore = yield* makeLocalState();
      yield* withServer(
        {},
        {},
        (url) =>
          Effect.gen(function* () {
            const client = yield* makeHttpStateStore({ url, authToken: AUTH_TOKEN, id: "http" });
            const next = yield* Deploy.deploy({
              stack: randomStack(client, stackName),
              stage: STAGE,
            }).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnv({ env: {} }),
              ),
            );
            expect(Redacted.value(next.text)).toBe(expected);
            const saved = yield* client.get({
              stack: stackName,
              stage: STAGE,
              fqn: "migrated-random",
            });
            if (!isResourceState(saved))
              return yield* Effect.die("Reopened HTTP disk state missing");
            expect(saved.props?.initial).toBeUndefined();
            expect(Redacted.value((saved.attr as { text: Redacted.Redacted<string> }).text)).toBe(
              expected,
            );
            yield* client.deleteStack({ stack: stackName });
          }),
        reopenedStore,
      );
    }).pipe(Effect.provide(PlatformServices)),
  );
});
