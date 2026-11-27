import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import {
  CloudflareApiLive,
  providers,
  type ProviderRequirements,
} from "@alchemy.run/cloudflare/Providers";
import { describe, expect, it } from "@alchemy.run/test";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

describe("host-supplied Cloudflare credentials", { tags: ["unit", "provider:cloudflare"] }, () => {
  it.effect("resolves injected credentials without a Cloudflare profile", () => {
    const token = Redacted.make("fixture-token");
    const credentials = Layer.mergeAll(
      Layer.succeed(Credentials, Effect.succeed(apiTokenCredentials({ apiToken: token }))),
      Layer.succeed(
        CloudflareEnvironment,
        Effect.succeed({
          type: "apiToken",
          apiToken: token,
          accountId: "a".repeat(32),
          source: { type: "stored" },
        }),
      ),
    );
    const runtime = CloudflareApiLive({ credentials }).pipe(
      Layer.provideMerge(AlchemyContextLive),
      Layer.provideMerge(Layer.succeed(AuthProviders, {})),
      Layer.provideMerge(PlatformServices),
      Layer.provideMerge(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die(new Error("Unexpected network request"))),
        ),
      ),
      Layer.provideMerge(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { ALCHEMY_PROFILE: "nonexistent-injection-fixture" } }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const actual = yield* yield* Credentials;
      const environment = yield* yield* CloudflareEnvironment;
      expect(actual.type).toBe("apiToken");
      if (actual.type !== "apiToken") throw new Error("Unexpected credential type");
      expect(actual.apiToken).toBe(token);
      expect(environment.accountId).toBe("a".repeat(32));
    }).pipe(Effect.provide(runtime), Effect.scoped);
  });
});

class HostCredential extends Context.Service<HostCredential, string>()("test/HostCredential") {}
it(
  "preserves default and custom provider requirement types",
  () => {
    const defaultIsPrecise: unknown extends ProviderRequirements ? never : true = true;
    const omitted = providers();
    const empty = providers({});
    const omittedIsPrecise: unknown extends Layer.Services<typeof omitted> ? never : true = true;
    const emptyIsPrecise: unknown extends Layer.Services<typeof empty> ? never : true = true;
    const supplied = Layer.mergeAll(
      Layer.effect(
        Credentials,
        Effect.map(HostCredential, (token) =>
          Effect.succeed(apiTokenCredentials({ apiToken: Redacted.make(token) })),
        ),
      ),
      Layer.effect(
        CloudflareEnvironment,
        Effect.map(HostCredential, (token) =>
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make(token),
            accountId: "a".repeat(32),
            source: { type: "stored" },
          }),
        ),
      ),
    );
    const custom = providers({ credentials: supplied });
    const customIsPrecise: unknown extends Layer.Services<typeof custom> ? never : true = true;
    const customPreservesHost: HostCredential extends Layer.Services<typeof custom> ? true : never =
      true;
    expect([
      defaultIsPrecise,
      omittedIsPrecise,
      emptyIsPrecise,
      customPreservesHost,
      customIsPrecise,
    ]).toEqual([true, true, true, true, true]);
  },
  { tags: ["unit", "provider:cloudflare"] },
);
