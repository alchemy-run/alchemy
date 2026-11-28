import type { CloudflareAuthConfig } from "@alchemy.run/cloudflare/Auth/AuthConfig";
import { CloudflareAuth } from "@alchemy.run/cloudflare/Auth/AuthProvider";
import { OAUTH_CLIENT_ID } from "@alchemy.run/cloudflare/Auth/OAuthClient";
import { expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthProvidersLive, getAuthProvider } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import * as Interaction from "alchemy/Interaction";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";

const expired: CloudflareAuthConfig = {
  method: "oauth",
  scopes: ["zone.read"],
  accountId: "0123456789abcdef0123456789abcdef",
  clientId: OAUTH_CLIENT_ID,
  access: "spent-access",
  refresh: "spent-refresh",
  expires: 0,
};

it.live(
  "an interrupt during an OAuth refresh still saves the rotated refresh token",
  () =>
    Effect.gen(function* () {
      // Profile locks live under ALCHEMY_HOME: keep them out of the real one.
      const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.ALCHEMY_HOME;
          process.env.ALCHEMY_HOME = home;
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.ALCHEMY_HOME;
            else process.env.ALCHEMY_HOME = previous;
          }),
      );
      yield* Layer.build(CloudflareAuth);
      const provider = yield* getAuthProvider<CloudflareAuthConfig, unknown>("Cloudflare");

      // Cloudflare has rotated the token by the time it answers, slowly.
      let requested = false;
      const fetch = (async () => {
        requested = true;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "zone.read",
        });
      }) as unknown as typeof globalThis.fetch;
      let saved: CloudflareAuthConfig | undefined;
      const read = yield* provider
        .read("refresh-interrupt", Effect.succeed(expired), (config) =>
          Effect.sync(() => {
            saved = config;
          }),
        )
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.forkChild);

      yield* Effect.sleep("100 millis");
      expect(requested).toBe(true);
      yield* Fiber.interrupt(read);

      expect(saved).toMatchObject({ access: "new-access", refresh: "new-refresh" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(AuthProvidersLive, CredentialsStoreLive).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto)),
        ),
      ),
      Effect.provide(Interaction.layerNonInteractive()),
    ),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:auth"], exclusive: true },
);
