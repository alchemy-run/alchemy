import { AuthProviders } from "@/Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "@/Auth/Credentials.ts";
import { ProfileStore, ProfileStoreLive } from "@/Auth/Profile.ts";
import {
  credentialsLayer,
  readCredentialConfig,
} from "@/Cloudflare/Workers/ViteChildCredentials.ts";
import { unwrapRedacted } from "@/Util/data.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as V8 from "node:v8";

const stores = Layer.mergeAll(
  ProfileStoreLive,
  CredentialsStoreLive,
  Layer.succeed(AuthProviders, {}),
).pipe(Layer.provideMerge(PlatformServices));
const accountId = "00000000000000000000000000000000";
const resolve = (config: Record<string, string>) =>
  Credentials.pipe(
    Effect.flatMap((credentials) => credentials),
    Effect.provide(credentialsLayer(config)),
  );

describe("Vite child tooling credentials", () => {
  for (const encoding of ["json", "v8"] as const) {
    it.effect(
      `resolves managed credentials after ${encoding} transport without adding Worker bindings`,
      () =>
        Effect.gen(function* () {
          const credentialConfig = yield* readCredentialConfig.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                CLOUDFLARE_ACCOUNT_ID: accountId,
                CLOUDFLARE_API_TOKEN: "managed-token",
                ALCHEMY_PROFILE: "managed-profile",
                CI: "true",
                UNRELATED_SECRET: "unrelated",
              }),
            ),
          );
          const input = unwrapRedacted({
            credentialConfig,
            env: { API_KEY: Redacted.make("application-key") },
          });
          const received =
            encoding === "json"
              ? JSON.parse(JSON.stringify(input))
              : V8.deserialize(V8.serialize(input));
          expect(received.env).toEqual({ API_KEY: "application-key" });
          expect(received.credentialConfig.UNRELATED_SECRET).toBeUndefined();
          expect(received.credentialConfig.ALCHEMY_PROFILE).toBe(
            "managed-profile",
          );
          const credentials = yield* resolve(received.credentialConfig).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                CLOUDFLARE_ACCOUNT_ID: accountId,
                CLOUDFLARE_API_TOKEN: "stale-child-token",
              }),
            ),
          );
          expect(credentials.type).toBe("apiToken");
          if (credentials.type === "apiToken")
            expect(Redacted.value(credentials.apiToken)).toBe("managed-token");
        }).pipe(Effect.provide(stores)),
    );
  }
  it.effect(
    "does not revive a missing parent token from child configuration",
    () =>
      Effect.gen(function* () {
        const credentials = yield* resolve({
          CLOUDFLARE_ACCOUNT_ID: accountId,
          CLOUDFLARE_API_KEY: "managed-key",
          CLOUDFLARE_ACCOUNT_EMAIL: "dev@example.com",
          CI: "true",
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ CLOUDFLARE_API_TOKEN: "stale-token" }),
          ),
        );
        expect(credentials.type).toBe("apiKey");
        if (credentials.type === "apiKey") {
          expect(Redacted.value(credentials.apiKey)).toBe("managed-key");
          expect(credentials.email).toBe("dev@example.com");
        }
      }).pipe(Effect.provide(stores)),
  );
  it.live(
    "uses the forwarded profile when parent environment credentials are absent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-vite-auth-",
        });
        const previous = process.env.ALCHEMY_HOME;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.ALCHEMY_HOME = home;
          }),
          () =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.ALCHEMY_HOME;
              else process.env.ALCHEMY_HOME = previous;
            }),
        );
        yield* Effect.gen(function* () {
          const profiles = yield* ProfileStore;
          yield* profiles.createProfile("vite-profile");
          yield* profiles.setProviderConfig("vite-profile", "Cloudflare", {
            method: "stored",
            credentialType: "apiToken",
            apiToken: "profile-token",
            accountId,
          });
          const credentials = yield* resolve({
            ALCHEMY_PROFILE: "vite-profile",
            CI: "false",
          });
          expect(credentials.type).toBe("apiToken");
          if (credentials.type === "apiToken")
            expect(Redacted.value(credentials.apiToken)).toBe("profile-token");
        }).pipe(Effect.provide(stores));
      }).pipe(Effect.provide(PlatformServices)),
    { exclusive: true },
  );
});
