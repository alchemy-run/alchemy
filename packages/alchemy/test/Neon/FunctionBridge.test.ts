import { makeFunctionBridge } from "@/Neon/FunctionBridge";
import { FunctionRequest } from "@/Neon/FunctionEnvironment";
import { makeFunctionRuntimeContext } from "@/Neon/FunctionRuntimeContext";
import { expect, test } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

for (const cancellation of ["abort", "body"] as const)
  test.effect(
    `Function bridge closes the handler scope on ${cancellation} cancellation`,
    () =>
      Effect.gen(function* () {
        const finalized = yield* Deferred.make<void>();
        const runtime = yield* Effect.sync(() =>
          makeFunctionRuntimeContext("Bridge"),
        );
        let closed = false;
        yield* runtime.route(
          "/stream",
          Effect.gen(function* () {
            const scope = yield* Effect.scope;
            const request = yield* FunctionRequest;
            expect((yield* HttpServerRequest).source).toBe(request);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
              }).pipe(Effect.andThen(Deferred.succeed(finalized, undefined))),
            );
            return HttpServerResponse.stream(
              Stream.fromEffect(
                Effect.gen(function* () {
                  expect(yield* Effect.scope).toBe(scope);
                  return yield* Effect.sync(() =>
                    new TextEncoder().encode("first"),
                  );
                }),
              ).pipe(
                Stream.concat(Stream.never),
                Stream.provideService(Scope.Scope, scope),
              ),
            );
          }),
        );
        const bridge = yield* Effect.sync(() =>
          makeFunctionBridge(Effect.succeed({ RuntimeContext: runtime })),
        );
        const controller = yield* Effect.sync(() => new AbortController());
        const request = yield* Effect.sync(
          () =>
            new Request("https://function.test/stream", {
              signal: controller.signal,
            }),
        );
        const response = yield* Effect.tryPromise(() => bridge.fetch(request));
        const reader = yield* Effect.sync(() => response.body!.getReader());
        const first = yield* Effect.tryPromise(() => reader.read());
        expect(first.done).toBe(false);
        expect(closed).toBe(false);
        if (cancellation === "abort")
          yield* Effect.sync(() => controller.abort());
        else yield* Effect.tryPromise(() => reader.cancel());
        yield* Deferred.await(finalized);
        expect(closed).toBe(true);
        yield* Effect.tryPromise(() => reader.cancel());
      }),
  );

test.effect(
  "Function bridge closes bodyless request scopes without consuming a stream",
  () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.sync(() =>
        makeFunctionRuntimeContext("Bodyless"),
      );
      let finalized = 0;
      let consumed = 0;
      yield* runtime.route(
        "/",
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              finalized++;
            }),
          );
          return HttpServerResponse.stream(
            Stream.fromEffect(
              Effect.sync(() => {
                consumed++;
                return new TextEncoder().encode("body");
              }),
            ),
          );
        }),
      );
      const bridge = yield* Effect.sync(() =>
        makeFunctionBridge(Effect.succeed({ RuntimeContext: runtime })),
      );
      const request = yield* Effect.sync(
        () => new Request("https://function.test/", { method: "HEAD" }),
      );
      const response = yield* Effect.tryPromise(() => bridge.fetch(request));
      expect(response.body).toBe(null);
      expect(finalized).toBe(1);
      expect(consumed).toBe(0);
    }),
);
