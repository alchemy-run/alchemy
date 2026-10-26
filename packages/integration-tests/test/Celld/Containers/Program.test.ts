import { expect, it } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import { HttpServer } from "alchemy/Http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
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
          Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, RuntimeContext.phantom, server),
        ),
      );
      expect(closed).toBe(true);
    }),
  { tags: ["unit", "local", "provider:celld", "provider:celld:container"] },
);
