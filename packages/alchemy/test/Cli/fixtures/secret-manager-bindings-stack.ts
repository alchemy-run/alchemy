import { Stack } from "alchemy";
import * as State from "@/State/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { externalIntegration } from "../../fixtures/external-secret-manager.ts";

export const integration = externalIntegration();

export default Stack(
  "typed-secrets-fixture",
  {
    providers: Layer.empty,
    state: State.inMemoryState(),
    secrets: integration.layer,
  },
  Effect.gen(function* () {
    const env = yield* integration.bindings;
    return yield* Effect.all(env);
  }),
);
