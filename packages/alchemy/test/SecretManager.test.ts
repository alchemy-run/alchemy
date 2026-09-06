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
import { externalSecrets } from "./fixtures/external-secret-manager.ts";

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

it.effect("passes stack and stage and centrally composes the fallback", () =>
  Effect.gen(function* () {
    const fallback = ConfigProvider.fromUnknown({
      BOOTSTRAP: "bootstrap",
      FALLBACK_ONLY: "fallback",
      SHARED: "fallback",
    });
    let receivedStack: string | undefined;
    let receivedStage: string | undefined;
    let receivedBootstrap: string | undefined;
    const secrets = Layer.succeed(SecretManager, {
      name: "Test",
      resolve: ({ stack, stage }) =>
        Effect.gen(function* () {
          receivedStack = stack;
          receivedStage = stage;
          receivedBootstrap = yield* Config.string("BOOTSTRAP").pipe(
            Effect.orDie,
          );
          return ConfigProvider.fromUnknown({ SHARED: "manager" });
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
    expect(receivedBootstrap).toBe("bootstrap");
    expect(yield* read(resolved, "SHARED")).toBe("manager");
    expect(yield* read(resolved, "FALLBACK_ONLY")).toBe("fallback");
  }),
);

it.effect(
  "provides fallback configuration during scoped layer construction",
  () =>
    Effect.gen(function* () {
      let released = false;
      const secrets = Layer.effect(
        SecretManager,
        Effect.gen(function* () {
          const bootstrap = yield* Effect.acquireRelease(
            Config.string("LAYER_BOOTSTRAP").pipe(Effect.orDie),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          );
          return {
            name: "Scoped test",
            resolve: () =>
              Effect.succeed(ConfigProvider.fromUnknown({ VALUE: bootstrap })),
          };
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* resolveSecretManagerConfig({
            secrets,
            stack: "test-stack",
            fallback: ConfigProvider.fromUnknown({
              LAYER_BOOTSTRAP: "bootstrap",
              VALUE: "fallback",
            }),
          });
          expect(yield* read(resolved, "VALUE")).toBe("bootstrap");
          expect(released).toBe(false);
        }),
      );
      expect(released).toBe(true);
    }),
);

it.effect("does not apply provider-specific filtering", () =>
  Effect.gen(function* () {
    const secrets = Layer.succeed(SecretManager, {
      name: "Test",
      resolve: () => Effect.succeed(ConfigProvider.fromUnknown({})),
    });
    const resolved = yield* resolveSecretManagerConfig({
      secrets,
      stack: "test-stack",
      fallback: ConfigProvider.fromUnknown({
        __PROVIDER_PRIVATE_STATE: "preserved-by-core",
      }),
    });

    expect(yield* read(resolved, "__PROVIDER_PRIVATE_STATE")).toBe(
      "preserved-by-core",
    );
  }),
);

it.effect("supports integrations built only from the public contract", () =>
  Effect.gen(function* () {
    const resolved = yield* resolveSecretManagerConfig({
      secrets: externalSecrets(),
      stack: "external-stack",
      stage: "preview",
      fallback: ConfigProvider.fromUnknown({}),
    });

    expect(yield* read(resolved, "EXTERNAL_SECRET_SET")).toBe(
      "external-stack/preview",
    );
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
      resolve: () =>
        Effect.succeed(
          ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: "manager" }),
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
