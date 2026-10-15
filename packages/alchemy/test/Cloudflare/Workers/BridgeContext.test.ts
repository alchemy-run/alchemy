import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeDurableObjectBridge } from "@/Cloudflare/Workers/DurableObjectBridge.ts";
import { DurableObjectState } from "@/Cloudflare/Workers/DurableObjectState.ts";
import { makeRequestEffect } from "@/Cloudflare/Workers/HttpServer.ts";
import { Request as RawRequest } from "@/Cloudflare/Workers/Request.ts";
import {
  ErrorTag,
  fromRpcStreamEnvelope,
  toRpcStream,
  type RpcStreamEnvelope,
} from "@/Cloudflare/Workers/Rpc.ts";
import { makeWorkerBridge } from "@/Cloudflare/Workers/WorkerBridge.ts";
import { WorkerExecutionContext } from "@/Cloudflare/Workers/WorkerRuntime.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { Self } from "@/Self.ts";
import { Telemetry } from "@/TelemetryRuntime.ts";

class Collision extends Context.Service<Collision, string>()("test/bridge/Collision") {}
class BuiltOnly extends Context.Service<BuiltOnly, string>()("test/bridge/BuiltOnly") {}
class TelemetryValue extends Context.Service<TelemetryValue, string>()(
  "test/bridge/TelemetryValue",
) {}
class PerRequest extends Context.Service<PerRequest, number>()("test/bridge/PerRequest") {}
class InitDependency extends Context.Service<InitDependency, { readonly id: number }>()(
  "test/bridge/InitDependency",
) {}

const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const executionContext = () => {
  const pending: Promise<unknown>[] = [];
  return {
    raw: {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    },
    drain: async () => {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
  };
};

const makeBridge = <
  Services = never,
  TelemetryOut = never,
  TelemetryError = never,
  TelemetryIn = never,
>(
  kind: "worker" | "durable",
  run: (input: any) => Effect.Effect<any, any, any>,
  services?: Context.Context<Services>,
  telemetry?: Layer.Layer<TelemetryOut, TelemetryError, TelemetryIn>,
) => {
  const capturedServices = services ?? Context.empty();
  const runtime = {
    exports: Effect.succeed({
      default: { fetch: (input: unknown) => [run(input), capturedServices] },
      Counter: {
        kind: "durableObject",
        constructor: Effect.succeed(Effect.succeed({ run })),
        services: capturedServices,
      },
    }),
    shape: () => ({ run }),
    telemetry,
  };
  const entrypoint = Layer.mergeAll(
    Layer.succeed(Self as any, { RuntimeContext: runtime }),
    Layer.succeed(Collision, "built"),
    Layer.succeed(BuiltOnly, "built-only"),
    Layer.succeed(Telemetry, Layer.empty),
  );
  const options = { entrypoint, stack: { name: "bridge-context", stage: "test" } };
  class Base {
    constructor(
      public readonly ctx: any,
      public readonly env: any,
    ) {}
  }
  const Bridge =
    kind === "worker"
      ? makeWorkerBridge(Base as any, options)
      : makeDurableObjectBridge(Base as any, {
          ...options,
          // Both bridges pass the entrypoint to makeEntrypointLayer, which
          // accepts this Layer fixture; the DO bridge's annotation is narrower.
          entrypoint: entrypoint as unknown as Effect.Effect<Record<string, any>>,
        })("Counter");
  const instantiate = () => {
    const context = executionContext();
    const state = {
      ...context.raw,
      id: { toString: () => "counter" },
      storage: { sql: {}, kv: {} },
      blockConcurrencyWhile: (callback: () => Promise<unknown>) => callback(),
    };
    const raw = kind === "worker" ? context.raw : state;
    const instance = new Bridge(raw, {});
    return {
      raw,
      runtime,
      call: (input?: unknown): Promise<any> =>
        kind === "worker" ? instance.fetch(input) : instance.run(input),
      rpc: (input?: unknown): Promise<any> => instance.run(input),
      drain: context.drain,
    };
  };
  return { instantiate };
};

describe("Cloudflare bridge request contexts", { tags: ["unit", "local"] }, () => {
  for (const kind of ["worker", "durable"] as const) {
    it.effect(`${kind}: preserves captured, event, and telemetry precedence`, () =>
      Effect.gen(function* () {
        const staleScope = Scope.makeUnsafe();
        const captured = Context.make(Collision, "captured").pipe(
          Context.add(RuntimeContext, { stale: true } as any),
          Context.add(Scope.Scope, staleScope),
          Context.add(WorkerExecutionContext, { stale: true } as any),
          Context.add(DurableObjectState, { stale: true } as any),
        );
        const observed: string[] = [];
        let finalized = 0;
        const telemetry = Layer.effect(
          TelemetryValue,
          Effect.gen(function* () {
            observed.push(yield* Collision, yield* BuiltOnly);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized++;
              }),
            );
            return "telemetry";
          }),
        ).pipe(Layer.merge(Layer.succeed(Collision, "telemetry-wins")));
        const { instantiate } = makeBridge(
          kind,
          () =>
            Effect.gen(function* () {
              const event =
                kind === "worker" ? yield* WorkerExecutionContext : yield* DurableObjectState;
              return {
                collision: yield* Collision,
                built: yield* BuiltOnly,
                telemetry: yield* TelemetryValue,
                scope: yield* Scope.Scope,
                runtime: yield* RuntimeContext,
                raw: event.raw,
              };
            }),
          captured,
          telemetry,
        );
        const bridge = instantiate();
        const result = yield* Effect.promise(() => bridge.call());
        expect(observed).toEqual(["captured", "built-only"]);
        expect(result.collision).toBe("telemetry-wins");
        expect(result.telemetry).toBe("telemetry");
        expect(result.built).toBe("built-only");
        expect(result.scope).not.toBe(staleScope);
        expect(result.raw).toBe(bridge.raw);
        expect(result.runtime.stale).toBeUndefined();
        if (kind === "worker") expect(result.runtime).toBe(bridge.runtime);
        yield* Effect.promise(bridge.drain);
        expect(finalized).toBe(1);
        yield* Scope.close(staleScope, Exit.void);
      }),
    );

    it.effect(`${kind}: isolates concurrent request scopes and user Layer builds`, () =>
      Effect.gen(function* () {
        const started = [signal(), signal()];
        const release = [signal(), signal()];
        const scopes: Scope.Scope[] = [];
        const rawContexts: unknown[] = [];
        let acquired = 0;
        let released = 0;
        const perRequest = Layer.effect(
          PerRequest,
          Effect.acquireRelease(
            Effect.sync(() => ++acquired),
            () =>
              Effect.sync(() => {
                released++;
              }),
          ),
        );
        const { instantiate } = makeBridge(kind, (index: number) =>
          Effect.gen(function* () {
            scopes[index] = yield* Scope.Scope;
            rawContexts[index] = (
              kind === "worker" ? yield* WorkerExecutionContext : yield* DurableObjectState
            ).raw;
            return yield* Effect.gen(function* () {
              const value = yield* PerRequest;
              started[index].resolve();
              yield* Effect.promise(() => release[index].promise);
              return value;
            }).pipe(Effect.provide(perRequest));
          }),
        );
        const first = instantiate();
        const second = instantiate();
        const promises = [first.call(0), second.call(1)];
        yield* Effect.promise(() => Promise.all(started.map((entry) => entry.promise)));
        expect(acquired).toBe(2);
        expect(released).toBe(0);
        expect(scopes[0]).not.toBe(scopes[1]);
        expect(rawContexts).toEqual([first.raw, second.raw]);
        release[0].resolve();
        release[1].resolve();
        expect((yield* Effect.promise(() => Promise.all(promises))).sort()).toEqual([1, 2]);
        yield* Effect.promise(() => Promise.all([first.drain(), second.drain()]));
        expect(released).toBe(2);
        const third = yield* Effect.promise(() => first.call(0));
        expect(third).toBe(3);
        yield* Effect.promise(first.drain);
        expect(released).toBe(3);
      }),
    );

    it.effect(`${kind}: telemetry failure leaves handler context and finalizers intact`, () =>
      Effect.gen(function* () {
        let finalized = 0;
        const failing = Layer.effectDiscard(Effect.die("telemetry build failed"));
        const { instantiate } = makeBridge(
          kind,
          () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalized++;
                }),
              );
              return yield* Collision;
            }),
          Context.make(Collision, "captured"),
          failing,
        );
        const bridge = instantiate();
        expect(yield* Effect.promise(() => bridge.call())).toBe("captured");
        yield* Effect.promise(bridge.drain);
        expect(finalized).toBe(1);
      }),
    );

    for (const telemetryFails of [false, true]) {
      it.effect(
        `${kind}: shares init dependencies and isolates event resources when telemetry ${telemetryFails ? "fails" : "succeeds"}`,
        () =>
          Effect.gen(function* () {
            let initBuilds = 0;
            const initLayer = Layer.effect(
              InitDependency,
              Effect.sync(() => ({ id: ++initBuilds })),
            );
            // Init may retain pure services, but never acquire disposable resources.
            const initScope = Scope.makeUnsafe();
            const initMemoMap = Layer.makeMemoMapUnsafe();
            const captured = yield* Layer.buildWithMemoMap(initLayer, initMemoMap, initScope);
            const initial = Context.get(captured, InitDependency);
            let handlerAcquired = 0;
            let handlerReleased = 0;
            let telemetryAcquired = 0;
            let telemetryReleased = 0;
            const telemetryDependencies: Array<{ readonly id: number }> = [];
            const telemetryScopes: Scope.Scope[] = [];
            const requestLayer = Layer.effect(
              PerRequest,
              Effect.acquireRelease(
                Effect.sync(() => ++handlerAcquired),
                () =>
                  Effect.sync(() => {
                    handlerReleased++;
                  }),
              ),
            );
            const telemetry = Layer.effectDiscard(
              Effect.gen(function* () {
                telemetryDependencies.push(yield* InitDependency);
                telemetryScopes.push(yield* Effect.scope);
                yield* Effect.acquireRelease(
                  Effect.sync(() => ++telemetryAcquired),
                  () =>
                    Effect.sync(() => {
                      telemetryReleased++;
                    }),
                );
                if (telemetryFails) return yield* Effect.die("telemetry build failed");
              }),
            ).pipe(Layer.provide(initLayer));
            const { instantiate } = makeBridge(
              kind,
              () =>
                Effect.gen(function* () {
                  const shared = yield* InitDependency;
                  const memoMap = yield* Layer.CurrentMemoMap;
                  const scope = yield* Effect.scope;
                  // Explicit handler provision builds locally, rather than borrowing
                  // a Layer instance from the captured init memo map.
                  const rebuilt = yield* InitDependency.pipe(Effect.provide(initLayer));
                  const value = yield* PerRequest.pipe(Effect.provide(requestLayer));
                  return { shared, rebuilt, value, memoMap, scope };
                }),
              captured,
              telemetry,
            );
            const bridge = instantiate();
            const results: Array<{
              shared: { readonly id: number };
              rebuilt: { readonly id: number };
              value: number;
              memoMap: Layer.MemoMap;
              scope: Scope.Scope;
            }> = [];
            for (let event = 0; event < 2; event++) {
              results.push(yield* Effect.promise(() => bridge.call()));
              yield* Effect.promise(bridge.drain);
              expect(handlerAcquired).toBe(event + 1);
              expect(handlerReleased).toBe(event + 1);
              expect(telemetryAcquired).toBe(event + 1);
              expect(telemetryReleased).toBe(event + 1);
            }
            // Telemetry can reuse a pure init dependency through its parent map.
            // Captured service values also remain shared in every handler.
            expect(telemetryDependencies).toHaveLength(2);
            for (const dependency of telemetryDependencies) expect(dependency).toBe(initial);
            for (const result of results) {
              expect(result.shared).toBe(initial);
              expect(result.rebuilt).not.toBe(initial);
              expect(result.scope).not.toBe(initScope);
            }
            expect(initBuilds).toBe(3);
            expect(results[0].rebuilt).not.toBe(results[1].rebuilt);
            expect(results.map((result) => result.value)).toEqual([1, 2]);
            expect(results[0].memoMap).not.toBe(initMemoMap);
            expect(results[1].memoMap).not.toBe(initMemoMap);
            expect(results[0].memoMap).not.toBe(results[1].memoMap);
            expect(results[0].scope).not.toBe(results[1].scope);
            expect(telemetryScopes[0]).not.toBe(telemetryScopes[1]);
            yield* Scope.close(initScope, Exit.void);
            expect(handlerReleased).toBe(2);
            expect(telemetryReleased).toBe(2);
          }),
      );
    }

    it.effect(`${kind}: captures typed RPC failures and defects before finalizing`, () =>
      Effect.gen(function* () {
        let finalized = 0;
        const { instantiate } = makeBridge(kind, (defect: boolean) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized++;
              }),
            );
            return yield* defect
              ? Effect.die(new Error("handler defect"))
              : Effect.fail({ _tag: "ExpectedFailure", reason: "typed" });
          }),
        );
        const bridge = instantiate();
        expect(yield* Effect.promise(() => bridge.rpc(false))).toEqual({
          _tag: ErrorTag,
          error: { _tag: "ExpectedFailure", reason: "typed" },
        });
        yield* Effect.promise(bridge.drain);
        expect(finalized).toBe(1);
        const defect = yield* Effect.promise(async () => {
          try {
            await bridge.rpc(true);
            return "did not fail";
          } catch (error) {
            return (error as Error).message;
          }
        });
        expect(defect).toBe("handler defect");
        yield* Effect.promise(bridge.drain);
        expect(finalized).toBe(2);
      }),
    );

    for (const bytes of [false, true]) {
      for (const cancel of [false, true]) {
        it.effect(
          `${kind}: ${bytes ? "bytes" : "JSON"} RPC stream ${cancel ? "cancellation" : "completion"} closes the event scope`,
          () =>
            Effect.gen(function* () {
              const finalized = signal();
              const releaseTail = signal();
              const first = bytes ? new Uint8Array([1, 2]) : "first";
              const last = bytes ? new Uint8Array([3, 4]) : "last";
              let closed = false;
              const { instantiate } = makeBridge(kind, () =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      closed = true;
                      finalized.resolve();
                    }),
                  );
                  return Stream.concat(
                    Stream.make(first),
                    Stream.fromEffect(
                      cancel
                        ? Effect.never
                        : Effect.promise(() => releaseTail.promise).pipe(Effect.as(last)),
                    ),
                  );
                }),
              );
              const bridge = instantiate();
              const envelope: RpcStreamEnvelope = yield* Effect.promise(() => bridge.rpc());
              expect(closed).toBe(false);
              if (cancel) {
                const reader = envelope.body.getReader();
                yield* Effect.promise(() => reader.read());
                yield* Effect.promise(() => reader.cancel());
              } else {
                releaseTail.resolve();
                expect(yield* fromRpcStreamEnvelope(envelope).pipe(Stream.runCollect)).toEqual([
                  first,
                  last,
                ]);
              }
              yield* Effect.promise(() => finalized.promise);
              expect(closed).toBe(true);
              yield* Effect.promise(bridge.drain);
            }),
        );
      }
    }

    it.effect(`${kind}: RPC stream failure after a separate chunk closes the event scope`, () =>
      Effect.gen(function* () {
        const finalized = signal();
        const releaseTail = signal();
        let closed = false;
        const { instantiate } = makeBridge(kind, () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
                finalized.resolve();
              }),
            );
            return Stream.concat(
              Stream.make("first"),
              Stream.fromEffect(
                Effect.promise(() => releaseTail.promise).pipe(
                  Effect.andThen(Effect.fail({ _tag: "StreamFailure", reason: "tail" })),
                ),
              ),
            );
          }),
        );
        const bridge = instantiate();
        const envelope: RpcStreamEnvelope = yield* Effect.promise(() => bridge.rpc());
        expect(closed).toBe(false);
        const reader = envelope.body.getReader();
        const first = yield* Effect.promise(() => reader.read());
        expect(new TextDecoder().decode(first.value)).toBe('"first"\n');
        expect(closed).toBe(false);
        releaseTail.resolve();
        const failure = yield* Effect.promise(() => reader.read());
        expect(JSON.parse(new TextDecoder().decode(failure.value)).error).toEqual({
          _tag: "StreamFailure",
          reason: "tail",
        });
        expect((yield* Effect.promise(() => reader.read())).done).toBe(true);
        yield* Effect.promise(() => finalized.promise);
        expect(closed).toBe(true);
        yield* Effect.promise(bridge.drain);
      }),
    );

    it.effect(`${kind}: an empty RPC stream releases source and event scopes once`, () =>
      Effect.gen(function* () {
        let sourceClosed = 0;
        let eventClosed = 0;
        const { instantiate } = makeBridge(kind, () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                eventClosed++;
              }),
            );
            return Stream.unwrap(
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    sourceClosed++;
                  }),
                );
                return Stream.empty;
              }),
            );
          }),
        );
        const bridge = instantiate();
        const envelope: RpcStreamEnvelope = yield* Effect.promise(() => bridge.rpc());
        expect(yield* fromRpcStreamEnvelope(envelope).pipe(Stream.runCollect)).toEqual([]);
        yield* Effect.promise(bridge.drain);
        expect(sourceClosed).toBe(1);
        expect(eventClosed).toBe(1);
      }),
    );

    it.effect(`${kind}: byte RPC stream failure after its head closes the event scope`, () =>
      Effect.gen(function* () {
        const finalized = signal();
        const releaseTail = signal();
        const head = new Uint8Array([1, 2]);
        const failure = { _tag: "StreamFailure", reason: "byte tail" };
        let closed = false;
        const { instantiate } = makeBridge(kind, () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
                finalized.resolve();
              }),
            );
            return Stream.concat(
              Stream.make(head),
              Stream.fromEffect(
                Effect.promise(() => releaseTail.promise).pipe(
                  Effect.andThen(Effect.fail(failure)),
                ),
              ),
            );
          }),
        );
        const bridge = instantiate();
        const envelope: RpcStreamEnvelope = yield* Effect.promise(() => bridge.rpc());
        expect(envelope.encoding).toBe("bytes");
        expect(closed).toBe(false);
        const reader = envelope.body.getReader();
        expect((yield* Effect.promise(() => reader.read())).value).toEqual(head);
        expect(closed).toBe(false);
        releaseTail.resolve();
        const result = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: (error) => error,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toEqual(failure);
        yield* Effect.promise(() => finalized.promise);
        expect(closed).toBe(true);
        yield* Effect.promise(bridge.drain);
      }),
    );

    for (const defect of [false, true]) {
      it.effect(
        `${kind}: first-pull ${defect ? "defect" : "failure"} releases source and event scopes`,
        () =>
          Effect.gen(function* () {
            let sourceClosed = 0;
            let eventClosed = 0;
            const { instantiate } = makeBridge(kind, () =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    eventClosed++;
                  }),
                );
                return Stream.fromEffect(
                  Effect.gen(function* () {
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() => {
                        sourceClosed++;
                      }),
                    );
                    return yield* defect
                      ? Effect.die(new Error("first-pull defect"))
                      : Effect.fail({ _tag: "FirstPullFailure", reason: "before head" });
                  }),
                );
              }),
            );
            const bridge = instantiate();
            const result = yield* Effect.tryPromise({
              try: () => bridge.rpc(),
              catch: (error) => error,
            }).pipe(Effect.exit);
            expect(sourceClosed).toBe(1);
            expect(eventClosed).toBe(1);
            if (defect) {
              expect(Exit.isFailure(result)).toBe(true);
              if (Exit.isFailure(result)) {
                expect(Cause.squash(result.cause)).toMatchObject({ message: "first-pull defect" });
              }
            } else {
              expect(Exit.isSuccess(result)).toBe(true);
              if (Exit.isSuccess(result)) {
                const reader = (result.value as RpcStreamEnvelope).body.getReader();
                const marker = yield* Effect.promise(() => reader.read());
                expect(JSON.parse(new TextDecoder().decode(marker.value)).error).toEqual({
                  _tag: "FirstPullFailure",
                  reason: "before head",
                });
                expect((yield* Effect.promise(() => reader.read())).done).toBe(true);
              }
            }
            yield* Effect.promise(bridge.drain);
            expect(sourceClosed).toBe(1);
            expect(eventClosed).toBe(1);
          }),
      );
    }
  }

  it.effect(
    "interrupting RPC encoding before its head releases the source and attached event scope",
    () =>
      Effect.gen(function* () {
        const started = signal();
        const eventScope = Scope.makeUnsafe();
        let sourceClosed = 0;
        let eventClosed = 0;
        let returnedEnvelope = false;
        yield* Scope.addFinalizer(
          eventScope,
          Effect.sync(() => {
            eventClosed++;
          }),
        );
        const source = Stream.fromEffect(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                sourceClosed++;
              }),
            );
            started.resolve();
            return yield* Effect.never;
          }),
        ).pipe(Stream.onExit((exit) => Scope.close(eventScope, exit)));
        // This is the event-scope attachment used by handleRpcExit. Interrupt
        // the encoding fiber while its first pull is still pending.
        const fiber = yield* toRpcStream(source).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              returnedEnvelope = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.promise(() => started.promise);
        expect(sourceClosed).toBe(0);
        expect(eventClosed).toBe(0);
        yield* Fiber.interrupt(fiber);
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
        expect(returnedEnvelope).toBe(false);
        expect(sourceClosed).toBe(1);
        expect(eventClosed).toBe(1);
      }),
  );

  it.effect(
    "HTTP request values override stale outer services without dropping other services",
    () =>
      Effect.gen(function* () {
        const stale = new Request("https://stale.example/");
        const incoming = new Request("https://current.example/path");
        const handler = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const raw = yield* RawRequest;
          return HttpServerResponse.text(`${yield* Collision}|${request.url}|${raw.url}`);
        });
        // makeRequestEffect erases its result type, but supplies both request
        // services internally. Only this handler's Collision service remains.
        const requestEffect: Effect.Effect<Response, never, Collision> = makeRequestEffect(
          incoming as any,
          handler,
        );
        const response = yield* requestEffect.pipe(
          Effect.provideContext(
            Context.make(Collision, "retained").pipe(
              Context.add(RawRequest, stale as any),
              Context.add(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(stale)),
            ),
          ),
        );
        expect(yield* Effect.promise(() => response.text())).toBe(
          "retained|/path|https://current.example/path",
        );
      }),
  );

  it.effect("HTTP stream cancellation retains and then closes its request scope", () =>
    Effect.gen(function* () {
      const finalized = signal();
      let closed = false;
      const handler = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
            finalized.resolve();
          }),
        );
        return HttpServerResponse.stream(
          Stream.concat(
            Stream.make(new TextEncoder().encode("first")),
            Stream.fromEffect(Effect.never),
          ),
        );
      });
      // The adapter owns the HTTP request scope, including the handler's
      // finalizer; this fixture requires no ambient application services.
      const requestEffect: Effect.Effect<Response> = makeRequestEffect(
        new Request("https://worker.test/") as any,
        handler,
      );
      const response = yield* requestEffect;
      expect(closed).toBe(false);
      const reader = response.body!.getReader();
      yield* Effect.promise(() => reader.read());
      yield* Effect.promise(() => reader.cancel());
      yield* Effect.promise(() => finalized.promise);
      expect(closed).toBe(true);
    }),
  );
});
