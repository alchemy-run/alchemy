import type {
  CloudflareAuthConfig,
  CloudflareResolvedCredentials,
} from "@alchemy.run/cloudflare/Auth/AuthConfig";
import {
  CloudflareAuthConfigSchema,
  cloudflareCredentialExpiresAt,
  validateApiTokenExpiry,
} from "@alchemy.run/cloudflare/Auth/AuthConfig";
import { CloudflareAuth } from "@alchemy.run/cloudflare/Auth/AuthProvider";
import { CloudflareEnvironment, fromProfile } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { fromAuthProvider } from "@alchemy.run/cloudflare/Credentials";
import { cacheUntilExpiry } from "@alchemy.run/cloudflare/Credentials";
import { describe, expect, it } from "@alchemy.run/test";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { AuthProvidersLive, getAuthProvider } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStore, ProfileStoreLive } from "alchemy/Auth/Profile";
import { layerNonInteractive } from "alchemy/Interaction";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

describe("expiring API token credentials", { tags: ["unit", "provider:cloudflare"] }, () => {
  it.effect("refreshes API tokens at the safety window and preserves indefinite tokens", () =>
    Effect.gen(function* () {
      let resolutions = 0;
      const now = yield* Clock.currentTimeMillis;
      const resolve = Effect.sync(() => ({
        ...apiTokenCredentials({ apiToken: Redacted.make(`fixture-${++resolutions}`) }),
        expiresAt: now + 600_000,
      }));
      const cached = yield* cacheUntilExpiry(resolve);
      yield* cached;
      yield* cached;
      expect(resolutions).toBe(1);
      yield* TestClock.adjust("299 seconds");
      yield* cached;
      expect(resolutions).toBe(1);
      yield* TestClock.adjust("2 seconds");
      yield* cached;
      expect(resolutions).toBe(2);
      let indefiniteReads = 0;
      const indefinite = yield* cacheUntilExpiry(
        Effect.sync(() => {
          indefiniteReads++;
          return apiTokenCredentials({ apiToken: Redacted.make("fixture") });
        }),
      );
      yield* indefinite;
      yield* TestClock.adjust("365 days");
      yield* indefinite;
      expect(indefiniteReads).toBe(1);
    }),
  );

  it.effect("rejects expired metadata and accepts future or absent expiry", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const error = yield* validateApiTokenExpiry(now).pipe(Effect.flip);
      expect(error.message).toContain("expired");
      yield* validateApiTokenExpiry(now + 1000);
      yield* validateApiTokenExpiry(undefined);
    }),
  );

  it("retains validated expiry in profile contracts and the shared environment selector", () => {
    const config = Schema.decodeUnknownSync(CloudflareAuthConfigSchema)({
      method: "stored",
      credentialType: "apiToken",
      apiToken: "fixture",
      accountId: "a".repeat(32),
      expiresAt: 123456,
    });
    expect(config).toHaveProperty("expiresAt", 123456);
    expect(
      cloudflareCredentialExpiresAt({
        type: "apiToken",
        apiToken: Redacted.make("fixture"),
        accountId: "a".repeat(32),
        source: { type: "stored" },
        expiresAt: 123456,
      }),
    ).toBe(123456);
    expect(() =>
      Schema.decodeUnknownSync(CloudflareAuthConfigSchema)({
        method: "stored",
        credentialType: "apiToken",
        apiToken: "fixture",
        accountId: "a".repeat(32),
        expiresAt: -1,
      }),
    ).toThrow();
  });
});

it(
  "expires and replaces a stored profile through both real credential consumers",
  async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await mkdtemp(join(tmpdir(), "alchemy-token-expiry-"));
    const previous = process.env.ALCHEMY_HOME;
    process.env.ALCHEMY_HOME = home;
    try {
      const program = Effect.gen(function* () {
        const profile = yield* ProfileStore;
        yield* profile.createProfile("expiry-test");
        const auth = yield* getAuthProvider<CloudflareAuthConfig, CloudflareResolvedCredentials>(
          "Cloudflare",
        );
        if (auth.configureWith === undefined) throw new Error("Missing stored configuration API");
        const now = yield* Clock.currentTimeMillis;
        const config = yield* auth.configureWith("expiry-test", {
          method: "stored",
          values: {
            apiToken: "first-fixture",
            accountId: "a".repeat(32),
            expiresAt: String(now + 600_000),
          },
        });
        yield* profile.setProviderConfig("expiry-test", "Cloudflare", config);
        const api = yield* Credentials;
        const environment = yield* CloudflareEnvironment;
        expect((yield* api).type).toBe("apiToken");
        expect((yield* environment).type).toBe("apiToken");
        yield* TestClock.adjust("601 seconds");
        expect((yield* Effect.exit(api))._tag).toBe("Failure");
        expect((yield* Effect.exit(environment))._tag).toBe("Failure");
        const replacement = yield* auth.configureWith("expiry-test", {
          method: "stored",
          values: { apiToken: "replacement-fixture", accountId: "a".repeat(32) },
        });
        yield* profile.setProviderConfig("expiry-test", "Cloudflare", replacement);
        const freshApi = yield* api;
        const freshEnvironment = yield* environment;
        if (freshApi.type !== "apiToken" || freshEnvironment.type !== "apiToken")
          throw new Error("Unexpected credentials");
        expect(Redacted.value(freshApi.apiToken)).toBe("replacement-fixture");
        expect(Redacted.value(freshEnvironment.apiToken)).toBe("replacement-fixture");
        yield* TestClock.adjust("365 days");
        expect((yield* api).type).toBe("apiToken");
        expect((yield* environment).type).toBe("apiToken");
      });
      const runtime = Layer.mergeAll(fromAuthProvider(), fromProfile()).pipe(
        Layer.provideMerge(CloudflareAuth),
        Layer.provideMerge(ProfileStoreLive),
        Layer.provideMerge(CredentialsStoreLive),
        Layer.provideMerge(AuthProvidersLive),
        Layer.provideMerge(AlchemyContextLive),
        Layer.provideMerge(layerNonInteractive()),
        Layer.provideMerge(PlatformServices),
        Layer.provideMerge(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die(new Error("Unexpected network"))),
          ),
        ),
        Layer.provideMerge(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { ALCHEMY_PROFILE: "expiry-test", CI: "false" } }),
          ),
        ),
      );
      await Effect.runPromise(
        program.pipe(Effect.provide(runtime), Effect.provide(TestClock.layer()), Effect.scoped),
      );
    } finally {
      if (previous === undefined) delete process.env.ALCHEMY_HOME;
      else process.env.ALCHEMY_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  },
  { tags: ["unit", "provider:cloudflare"], exclusive: true },
);
