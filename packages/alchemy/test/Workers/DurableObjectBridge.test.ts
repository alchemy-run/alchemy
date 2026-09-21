import { Telemetry } from "@/TelemetryRuntime.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import type { DurableObjectExport } from "@/Workers/DurableObject.ts";
import { makeDurableObjectInstance } from "@/Workers/DurableObjectBridge.ts";
import type { WorkerBuild } from "@/Workers/Worker.ts";
import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

class State extends Context.Service<State, { readonly value: string }>()(
  "test/Workers/State",
) {}
class Invocation extends Context.Service<Invocation, string>()(
  "test/Workers/Invocation",
) {}

const makeBuild = (
  constructor: DurableObjectExport["constructor"],
): WorkerBuild<DurableObjectExport> => ({
  context: Context.make(Telemetry, Layer.empty).pipe(
    Context.add(State, { value: "global" }),
  ),
  export: {
    kind: "durableObject",
    provider: "test",
    constructor,
    services: Context.make(State, { value: "captured" }),
  },
  shape: () => ({}),
  telemetry: () => undefined,
});

const drain = (pending: readonly Promise<unknown>[]) =>
  Effect.forEach(pending, (promise) => Effect.promise(() => promise), {
    discard: true,
  });

describe("shared Durable Object instance bridge", () => {
  it.effect(
    "constructs once with provider services and closes distinct call scopes",
    () =>
      Effect.gen(function* () {
        let builds = 0;
        let constructions = 0;
        const scopes: Scope.Scope[] = [];
        const closed: string[] = [];
        const pending: Promise<unknown>[] = [];
        const built = makeBuild(
          Effect.gen(function* () {
            const state = yield* State;
            constructions++;
            return Effect.succeed({
              read: () =>
                Effect.gen(function* () {
                  scopes.push(yield* Effect.scope);
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      closed.push(state.value);
                    }),
                  );
                  expect((yield* State).value).toBe(state.value);
                  return state.value;
                }),
            });
          }),
        );
        const core = yield* Effect.sync(() =>
          makeDurableObjectInstance({
            build: () => {
              builds++;
              return Promise.resolve(built);
            },
            services: Context.make(State, { value: "provider" }),
            waitUntil: (promise) => {
              pending.push(promise);
            },
            dispatch: "proxy",
          }),
        );
        expect(yield* Effect.promise(() => core.dispatch("read")())).toBe(
          "provider",
        );
        expect(yield* Effect.promise(() => core.dispatch("read")())).toBe(
          "provider",
        );
        yield* drain(pending);
        expect(builds).toBe(1);
        expect(constructions).toBe(1);
        expect(scopes).toHaveLength(2);
        expect(scopes[0]).not.toBe(scopes[1]);
        expect(closed).toEqual(["provider", "provider"]);
      }),
  );

  it.effect(
    "keeps concurrent invocation contexts and lifetime hooks separate",
    () =>
      Effect.gen(function* () {
        const closed: string[] = [];
        const first: Promise<unknown>[] = [];
        const second: Promise<unknown>[] = [];
        const activation: Promise<unknown>[] = [];
        const built = makeBuild(
          Effect.succeed(
            Effect.succeed({
              read: () =>
                Effect.gen(function* () {
                  const before = yield* Invocation;
                  yield* Effect.yieldNow;
                  const after = yield* Invocation;
                  yield* Effect.addFinalizer(() =>
                    Effect.gen(function* () {
                      closed.push(yield* Invocation);
                    }),
                  );
                  return [before, after];
                }),
            }),
          ),
        );
        const core = yield* Effect.sync(() =>
          makeDurableObjectInstance({
            build: () => Promise.resolve(built),
            services: Context.make(Invocation, "activation"),
            waitUntil: (promise) => {
              activation.push(promise);
            },
            dispatch: "proxy",
          }),
        );
        const call = (value: string, pending: Promise<unknown>[]) =>
          Effect.promise(() =>
            core.execute(
              (instance) =>
                (
                  instance.read as () => Effect.Effect<
                    string[],
                    never,
                    Invocation
                  >
                )(),
              undefined,
              {
                services: Context.make(Invocation, value),
                waitUntil: (promise) => {
                  pending.push(promise);
                },
              },
            ),
          );
        const results = yield* Effect.all(
          [call("one", first), call("two", second)],
          { concurrency: "unbounded" },
        );
        yield* drain([...first, ...second]);
        expect(results).toEqual([
          ["one", "one"],
          ["two", "two"],
        ]);
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
        expect(activation).toHaveLength(0);
        expect(closed.sort()).toEqual(["one", "two"]);
      }),
  );

  it.effect("closes the request scope after a failed handler", () =>
    Effect.gen(function* () {
      const pending: Promise<unknown>[] = [];
      let closed = false;
      const built = makeBuild(Effect.succeed(Effect.succeed({})));
      const core = yield* Effect.sync(() =>
        makeDurableObjectInstance({
          build: () => Promise.resolve(built),
          services: Context.empty(),
          waitUntil: (promise) => {
            pending.push(promise);
          },
          dispatch: "proxy",
        }),
      );
      const result = yield* Effect.promise(() =>
        core.execute(
          () =>
            Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
              }),
            ).pipe(Effect.andThen(Effect.fail("failed"))),
          (exit) => Promise.resolve(exit),
        ),
      );
      yield* drain(pending);
      expect(Exit.isFailure(result)).toBe(true);
      expect(closed).toBe(true);
    }),
  );

  for (const fail of [false, true]) {
    it.effect(
      `limits callback registration to inner initialization (${fail ? "failure" : "success"})`,
      () =>
        Effect.gen(function* () {
          let open = false;
          let seals = 0;
          const activationScope = yield* Scope.make();
          const pending: Promise<unknown>[] = [];
          const runtime: RuntimeContext["Service"] = {
            Type: "test",
            id: "worker",
            env: {},
            get: () => Effect.succeed(undefined),
            set: (key) => Effect.succeed(key),
          };
          const built = makeBuild(
            Effect.gen(function* () {
              expect((yield* RuntimeContext).id).toBe("worker");
              expect(open).toBe(false);
              return Effect.gen(function* () {
                expect((yield* RuntimeContext).id).toBe("worker:instance");
                expect(yield* Effect.scope).toBe(activationScope);
                expect(open).toBe(true);
                if (fail) return yield* Effect.die("initialization failed");
                return {};
              });
            }),
          );
          const core = yield* Effect.sync(() =>
            makeDurableObjectInstance({
              build: () => Promise.resolve(built),
              services: Context.make(RuntimeContext, runtime).pipe(
                Context.add(Scope.Scope, activationScope),
              ),
              runtimeContext: (context) => ({
                ...context,
                id: `${context.id}:instance`,
              }),
              initialize: () => {
                open = true;
                return () => {
                  open = false;
                  seals++;
                };
              },
              waitUntil: (promise) => {
                pending.push(promise);
              },
              dispatch: "proxy",
            }),
          );
          const exit = yield* Effect.tryPromise(() => core.instance).pipe(
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(fail);
          expect(open).toBe(false);
          expect(seals).toBe(1);
          if (!fail) {
            const id = yield* Effect.promise(() =>
              core.execute(
                () =>
                  Effect.gen(function* () {
                    expect(open).toBe(false);
                    expect(yield* Effect.scope).not.toBe(activationScope);
                    return (yield* RuntimeContext).id;
                  }),
                undefined,
                {
                  services: Context.make(RuntimeContext, {
                    ...runtime,
                    id: "request",
                  }),
                },
              ),
            );
            expect(id).toBe("request:instance");
            yield* drain(pending);
          }
          yield* Scope.close(activationScope, Exit.void);
        }),
    );
  }
});
