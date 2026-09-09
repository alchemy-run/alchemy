import {
  makeSecretManager,
  type SecretManagerLayer,
  SecretManagerContext,
  resolveSecretManager,
} from "@/SecretManager.ts";
import type { NormalizedBindings } from "@/Cloudflare/Workers/Worker.ts";
import { expect, it } from "alchemy-test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { externalIntegration } from "./fixtures/external-secret-manager.ts";

const withSession = <A, E, R>(
  integration: { readonly layer: SecretManagerLayer },
  stage: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveSecretManager({
      secrets: integration.layer,
      stack: "app",
      stage,
      fallback: ConfigProvider.fromUnknown({ BOOTSTRAP_TOKEN: "bootstrap" }),
    });
    return yield* effect.pipe(
      Effect.provideService(SecretManagerContext, resolved),
      Effect.provideService(ConfigProvider.ConfigProvider, resolved.provider),
    );
  });

it.effect(
  "preserves external binding types and reads the session without resolving again",
  () =>
    Effect.gen(function* () {
      let resolutions = 0;
      const integration = externalIntegration(() => resolutions++);
      yield* withSession(
        integration,
        "preview",
        Effect.gen(function* () {
          const bindings = yield* integration.bindings;
          expect(yield* integration.bindings).toBe(bindings);
          bindings.API_KEY satisfies Config.Config<Redacted.Redacted<string>>;
          bindings.PUBLIC_URL satisfies Config.Config<string>;
          bindings.FEATURE_ENABLED satisfies Config.Config<boolean>;
          // @ts-expect-error Remote metadata does not widen a generated schema to arbitrary keys.
          void bindings.UNKNOWN_KEY;
          const runtime: NormalizedBindings<typeof bindings> = {
            API_KEY: "secret",
            PUBLIC_URL: "public",
            FEATURE_ENABLED: true,
            __INTEGRATION_ENV: "runtime",
          };
          expect(runtime.FEATURE_ENABLED).toBe(true);
          const values = yield* Effect.all(bindings);
          expect(Redacted.value(values.API_KEY)).toBe("secret-preview");
          expect(values.PUBLIC_URL).toBe("https://preview.example.com");
          expect(values.FEATURE_ENABLED).toBe(true);
          expect(Redacted.value(values.__INTEGRATION_ENV)).toBe(
            "runtime-preview",
          );
          expect(Object.keys(values).sort()).toEqual([
            "API_KEY",
            "FEATURE_ENABLED",
            "PUBLIC_URL",
            "__INTEGRATION_ENV",
          ]);
          expect(yield* Config.string("DEPLOY_TOKEN")).toBe("tooling-only");
          expect(yield* Config.string("BOOTSTRAP_TOKEN")).toBe("bootstrap");
        }),
      );
      expect(resolutions).toBe(1);
    }),
);

it.effect(
  "isolates concurrent stages and resolves again for a new session",
  () =>
    Effect.gen(function* () {
      let resolutions = 0;
      const integration = externalIntegration(() => resolutions++);
      const read = integration.bindings.pipe(Effect.flatMap(Effect.all));
      const values = yield* Effect.all(
        [
          withSession(integration, "dev", read),
          withSession(integration, "prod", read),
        ],
        { concurrency: "unbounded" },
      );
      expect(values.map((value) => Redacted.value(value.API_KEY))).toEqual([
        "secret-dev",
        "secret-prod",
      ]);
      expect((yield* withSession(integration, "reload", read)).PUBLIC_URL).toBe(
        "https://reload.example.com",
      );
      expect(resolutions).toBe(3);
    }),
);

it.effect("rejects unconfigured and different adapter handles", () =>
  Effect.gen(function* () {
    const first = externalIntegration();
    const second = externalIntegration();
    expect((yield* first.bindings.pipe(Effect.flip))._tag).toBe("ConfigError");
    expect(
      (yield* withSession(first, "dev", second.bindings.pipe(Effect.flip)))
        ._tag,
    ).toBe("ConfigError");
  }),
);

it.effect("refreshes the selected keys and their sensitivity on reload", () =>
  Effect.gen(function* () {
    let version = 0;
    const integration = makeSecretManager({
      name: "Dynamic fixture",
      resolve: () =>
        Effect.sync(() => {
          const bindings: Record<
            string,
            Config.Config<string | Redacted.Redacted<string>>
          > = version++ === 0
            ? { VALUE: Config.string("VALUE") }
            : {
                VALUE: Config.redacted("VALUE"),
                ADDED: Config.string("ADDED"),
              };
          return {
            provider: ConfigProvider.fromUnknown({
              VALUE: "same-value",
              ADDED: "new",
            }),
            bindings,
          };
        }),
    });
    const read = Effect.gen(function* () {
      const resolved = yield* resolveSecretManager({
        stack: "app",
        stage: "dev",
        secrets: integration.layer,
        fallback: ConfigProvider.fromUnknown({}),
      });
      return yield* integration.bindings.pipe(
        Effect.flatMap((bindings) => Effect.all(bindings)),
        Effect.provideService(SecretManagerContext, resolved),
        Effect.provideService(ConfigProvider.ConfigProvider, resolved.provider),
      );
    });
    expect((yield* read).VALUE).toBe("same-value");
    const updated = yield* read;
    expect(Redacted.isRedacted(updated.VALUE)).toBe(true);
    expect(updated.ADDED).toBe("new");
  }),
);

it.effect(
  "keeps provider-only handles usable and reports that no bindings were supplied",
  () =>
    Effect.gen(function* () {
      const integration = makeSecretManager({
        name: "Legacy fixture",
        resolve: () =>
          Effect.succeed(ConfigProvider.fromUnknown({ VALUE: "legacy" })),
      });
      yield* withSession(
        integration,
        "dev",
        Effect.gen(function* () {
          expect(yield* Config.string("VALUE")).toBe("legacy");
          expect((yield* integration.bindings.pipe(Effect.flip))._tag).toBe(
            "ConfigError",
          );
        }),
      );
    }),
);
