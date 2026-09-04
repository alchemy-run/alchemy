import {
  SecretManager,
  SecretManagerError,
  resolveSecretManagerConfig,
} from "@/SecretManager.ts";
import { withProfileOverride } from "@/Auth/Resolve.ts";
import { expect, it } from "alchemy-test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const read = (provider: ConfigProvider.ConfigProvider, name: string) =>
  Config.string(name).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  );

it.effect(
  "uses the existing provider when no secret manager is configured",
  () =>
    Effect.gen(function* () {
      const fallback = ConfigProvider.fromUnknown({ VALUE: "fallback" });
      const resolved = yield* resolveSecretManagerConfig({
        stack: "test-stack",
        fallback,
      });
      expect(resolved).toBe(fallback);
      expect(yield* read(resolved, "VALUE")).toBe("fallback");
    }),
);

it.effect("passes stack, stage, and fallback to a generic secret manager", () =>
  Effect.gen(function* () {
    const fallback = ConfigProvider.fromUnknown({
      FALLBACK_ONLY: "fallback",
      SHARED: "fallback",
    });
    let receivedStack: string | undefined;
    let receivedStage: string | undefined;
    const secrets = Layer.succeed(SecretManager, {
      name: "Test",
      resolve: ({ stack, stage, fallback }) =>
        Effect.sync(() => {
          receivedStack = stack;
          receivedStage = stage;
          return ConfigProvider.orElse(
            ConfigProvider.fromUnknown({ SHARED: "manager" }),
            fallback,
          );
        }),
    });

    const resolved = yield* resolveSecretManagerConfig({
      secrets,
      stack: "test-stack",
      stage: "preview-42",
      fallback,
    });

    expect(receivedStack).toBe("test-stack");
    expect(receivedStage).toBe("preview-42");
    expect(yield* read(resolved, "SHARED")).toBe("manager");
    expect(yield* read(resolved, "FALLBACK_ONLY")).toBe("fallback");
  }),
);

it.effect("surfaces typed secret-manager failures", () => {
  const failure = new SecretManagerError({
    manager: "Test",
    message: "Could not resolve configuration.",
  });
  const secrets = Layer.succeed(SecretManager, {
    name: "Test",
    resolve: () => Effect.fail(failure),
  });

  return resolveSecretManagerConfig({
    secrets,
    stack: "test-stack",
    fallback: ConfigProvider.fromUnknown({}),
  }).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error).toBe(failure);
        expect(error._tag).toBe("SecretManagerError");
      }),
    ),
  );
});

it.effect("keeps an explicit profile override at highest precedence", () =>
  Effect.gen(function* () {
    const secrets = Layer.succeed(SecretManager, {
      name: "Test",
      resolve: ({ fallback }) =>
        Effect.succeed(
          ConfigProvider.orElse(
            ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: "manager" }),
            fallback,
          ),
        ),
    });
    const resolved = yield* resolveSecretManagerConfig({
      secrets,
      stack: "test-stack",
      fallback: ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: "fallback" }),
    });

    expect(
      yield* read(withProfileOverride(resolved, "explicit"), "ALCHEMY_PROFILE"),
    ).toBe("explicit");
  }),
);
