import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { Reentrant } from "./fixtures/reentrant-declaration.ts";
import { ReentrantLive } from "./fixtures/reentrant.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "RivetDurableObjectPlan", import.meta.url);

// Planning only: a class phase that reached its own namespace used to make
// the class depend on itself, and the plan waited on that forever.
const plan = (effect: Effect.Effect<unknown, never, any>) =>
  stack.plan(effect).pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.die(new Error("the plan hung")),
    }),
    Effect.exit,
  );

describe("Rivet.DurableObject", { tags: ["provider:rivet", "local"] }, () => {
  test(
    "an implementation can yield its own declaration",
    Effect.gen(function* () {
      const exit = yield* plan(Effect.asVoid(Reentrant).pipe(Effect.provide(ReentrantLive)));
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
    { timeout: 60_000 },
  );
});
