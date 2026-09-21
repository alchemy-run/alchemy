import { HttpServer } from "@/Http.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { BunServices } from "@effect/platform-bun";
import { expect, it } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import ToolLive from "./fixtures/Tool.runtime.ts";

it.effect(
  "generated container program keeps its server alive and closes its process scope",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let closed = false;
      const server = Layer.succeed(HttpServer, {
        serve: (_handler, options) =>
          Effect.gen(function* () {
            expect(options?.port).toBe(3000);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
              }),
            );
            yield* Deferred.succeed(started, undefined);
          }),
      });
      yield* Effect.gen(function* () {
        yield* Effect.forkScoped(ToolLive["~celld/Container/Program"]);
        yield* Deferred.await(started);
        expect(closed).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            FetchHttpClient.layer,
            RuntimeContext.phantom,
            server,
          ),
        ),
      );
      expect(closed).toBe(true);
    }),
);
