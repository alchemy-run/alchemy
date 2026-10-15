import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { Credentials, CredentialsFromBoundEnv } from "@/Fly/Credentials.ts";
import { packEnvValue } from "@/RuntimeContext.ts";

const TOKEN = "FlyV1 fm2_unit-test-token";

const resolve = (env: Record<string, string>) =>
  Credentials.pipe(
    Effect.flatMap((config) => config),
    Effect.provide(CredentialsFromBoundEnv),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  );

describe("Fly CredentialsFromBoundEnv", { tags: ["unit", "local"] }, () => {
  it.effect("reads the token bound as a Redacted value", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ FLY_API_TOKEN: packEnvValue(Redacted.make(TOKEN)) });
      expect(Redacted.value(config.apiKey)).toBe(TOKEN);
      expect(config.apiBaseUrl).toBe("https://api.machines.dev");
    }),
  );

  it.effect("reads a raw token and a custom API hostname", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        FLY_API_TOKEN: TOKEN,
        FLY_API_HOSTNAME: "https://machines.example.test/v1/",
      });
      expect(Redacted.value(config.apiKey)).toBe(TOKEN);
      expect(config.apiBaseUrl).toBe("https://machines.example.test");
    }),
  );

  it.effect("falls back to FLY_IO_API_KEY", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ FLY_IO_API_KEY: TOKEN });
      expect(Redacted.value(config.apiKey)).toBe(TOKEN);
    }),
  );

  it.effect("dies without a token", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(resolve({}));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
