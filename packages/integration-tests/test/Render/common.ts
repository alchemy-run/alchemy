import * as Render from "@alchemy.run/render";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { renderApi } from "./limit.ts";

const renderProviders = Layer.merge(
  Render.providers(),
  Layer.succeed(Render.RenderPollConfig, {
    intervalMs: 4_000,
    maxAttempts: 45,
  }),
);

export const makeRenderTest = () => Test.make({ limit: renderApi, providers: renderProviders });

export const expectAllNoop = <A, E, R>(
  stack: Pick<Test.ScratchStack, "plan">,
  program: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const plan = yield* stack.plan(program as Effect.Effect<A, E, Render.ProviderRequirements>);
    for (const [id, entry] of Object.entries(plan.resources)) {
      expect({ id, action: (entry as { readonly action?: string } | undefined)?.action }).toEqual({
        id,
        action: "noop",
      });
    }
  });
