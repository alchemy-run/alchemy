import { ApiToken, ApiTokenProvider } from "@/Forgejo/ApiToken.ts";
import * as Test from "@/Test/Alchemy.ts";
import { Credentials, Services, credentials } from "@distilled.cloud/forgejo";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { runtimeProviders } from "./support/runtime-providers.ts";

const { test } = Test.make({ providers: runtimeProviders });

test.provider.skipIf(process.env.FORGEJO_RUNTIME_TEST !== "1")(
  "live: automatic token username and actionable bootstrap denial",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bootstrap = yield* yield* Credentials;
      const limited = yield* stack.deploy(
        ApiToken("LimitedBootstrap", { scopes: ["read:user"] }),
      );
      expect(limited.username).toBe("alchemy-admin");
      const denied = yield* Effect.gen(function* () {
        const provider = yield* ApiToken.Provider;
        return yield* provider
          .reconcile({
            id: "DeniedRuntimeToken",
            fqn: "DeniedRuntimeToken",
            instanceId: "denied",
            news: {
              name: "alchemy-denied-runtime-token",
              scopes: ["read:repository"],
            },
            olds: undefined,
            output: undefined,
            bindings: [],
            session: {
              emit: () => Effect.void,
              done: () => Effect.void,
              note: () => Effect.void,
            },
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("ForgejoTokenBootstrapDenied", (error) => {
              expect(error.message).toContain(
                "administrator deployment profile",
              );
              expect(error.message).toContain("write:admin");
              return Effect.succeed(true);
            }),
          );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ApiTokenProvider(),
            credentials({
              baseUrl: bootstrap.apiBaseUrl,
              token: limited.token,
            }),
          ),
        ),
      );
      expect(denied).toBe(true);
      const list = yield* Services.admin.adminListUserAccessTokens({
        username: limited.username,
      });
      expect(
        list.some((token) => token.name === "alchemy-denied-runtime-token"),
      ).toBe(false);
      yield* stack.destroy();
      expect(
        (yield* Services.admin.adminListUserAccessTokens({
          username: limited.username,
        })).some((token) => token.id === limited.tokenId),
      ).toBe(false);
    }),
  { timeout: 90_000 },
);
