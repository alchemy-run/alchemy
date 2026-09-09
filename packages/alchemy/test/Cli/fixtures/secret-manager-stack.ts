import { AuthProviderLayer } from "@/Auth/AuthProvider.ts";
import { SecretManager } from "@/SecretManager.ts";
import { Stack } from "@/Stack.ts";
import * as State from "@/State/index.ts";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProviderSecret, StateSecret } from "./secret-manager-probes.ts";

const fixtureAuth = AuthProviderLayer<{ method: "fixture" }, string>()(
  "FixtureAuth",
  Effect.gen(function* () {
    const secret = yield* Config.string("FIXTURE_SECRET");
    return {
      configSchema: Schema.Struct({ method: Schema.Literal("fixture") }),
      configure: () => Effect.succeed({ method: "fixture" as const }),
      login: () => Effect.void,
      logout: () => Effect.void,
      details: () =>
        Effect.succeed({ lines: [{ key: "source", value: secret }] }),
      read: () => Effect.succeed(secret),
    };
  }).pipe(Effect.orDie),
);

const fixtureState = Layer.effect(
  State.State,
  Effect.gen(function* () {
    const secret = yield* Config.string("FIXTURE_SECRET");
    const service = yield* State.InMemoryService();
    return Effect.succeed({ ...service, id: `fixture-${secret}` });
  }),
);

export default Stack(
  "secret-manager-fixture",
  {
    providers: Layer.mergeAll(
      Layer.effect(ProviderSecret, Config.string("FIXTURE_SECRET")),
      fixtureAuth,
    ) as any,
    state: Layer.mergeAll(
      fixtureState,
      Layer.effect(StateSecret, Config.string("FIXTURE_SECRET")),
    ) as any,
    secrets: Layer.succeed(SecretManager, {
      name: "Fixture",
      resolve: ({ stack, stage }) =>
        Effect.succeed(
          ConfigProvider.fromUnknown({
            ALCHEMY_PROFILE: "manager-profile",
            FIXTURE_STACK: stack,
            FIXTURE_SECRET: `secret-${stage ?? "native"}`,
            NEON_API_KEY: `neon-${stage ?? "native"}`,
          }),
        ),
    }),
  },
  Config.all({
    secret: Config.string("FIXTURE_SECRET"),
    stack: Config.string("FIXTURE_STACK"),
  }),
);
