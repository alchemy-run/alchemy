import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cloudflare from "@/Cloudflare";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State/InMemoryState.ts";

const tags = ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"];

const compile = <A>(effect: Effect.Effect<A, any, any>, name: string) =>
  effect.pipe(
    Stack.make({
      name,
      providers: Layer.empty,
      state: inMemoryState(),
    }),
    Effect.provideService(Stage, "test"),
  );

describe("DurableObject.from same-worker binding (#1843)", { tags }, () => {
  test.effect(
    "Counter.from(HostWorker), used inside HostWorker's own constructor, binds locally",
    () =>
      Effect.gen(function* () {
        class Counter extends Cloudflare.DurableObject<Counter, {}>()("Counter") {}
        class HostWorker extends Cloudflare.Worker<HostWorker, {}, Counter>()("HostWorker") {}

        const requireHostWorker = Effect.gen(function* () {
          yield* HostWorker;
        });

        const program = requireHostWorker.pipe(
          Effect.provide(
            HostWorker.make(
              { main: import.meta.url },
              Effect.gen(function* () {
                yield* Counter.from(HostWorker);
                return { fetch: () => new Response("ok") };
              }),
            ),
          ),
        );

        const compiled = yield* compile(program, "do-from-self");

        const registered = compiled.bindings.HostWorker?.[0]?.data?.bindings?.[0] as
          | { scriptName?: unknown }
          | undefined;

        expect(registered).toBeDefined();
        expect(registered?.scriptName).toBeUndefined();
      }),
  );

  test.effect("Counter.from(OtherWorker), a genuinely different Worker, stays cross-script", () =>
    Effect.gen(function* () {
      class Counter extends Cloudflare.DurableObject<Counter, {}>()("Counter") {}
      class OtherWorker extends Cloudflare.Worker<OtherWorker, {}, Counter>()("OtherWorker") {}
      class HostWorker extends Cloudflare.Worker<HostWorker, {}, Counter>()("HostWorker") {}

      const requireHostWorker = Effect.gen(function* () {
        yield* OtherWorker;
        yield* HostWorker;
      });

      const program = requireHostWorker.pipe(
        Effect.provide(
          HostWorker.make(
            { main: import.meta.url },
            Effect.gen(function* () {
              yield* Counter.from(OtherWorker);
              return { fetch: () => new Response("ok") };
            }),
          ),
        ),
      );

      const compiled = yield* compile(program, "do-from-other");

      const registered = compiled.bindings.HostWorker?.[0]?.data?.bindings?.[0] as
        | { scriptName?: unknown }
        | undefined;

      expect(registered).toBeDefined();
      expect(registered?.scriptName).toBeDefined();
    }),
  );
});
