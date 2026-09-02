import { AuthProviders } from "@/Auth/AuthProvider";
import { CredentialsStore } from "@/Auth/Credentials";
import { ProfileStore } from "@/Auth/Profile";
import * as CliKit from "@/Cli/CliKit";
import { ForgejoAuth } from "@/Forgejo/AuthProvider";
import { fromAuthProvider } from "@/Forgejo/Credentials.ts";
import { Credentials, Services } from "@distilled.cloud/forgejo";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  makeFakeCredentialsStore,
  makeFakeProfileStore,
} from "../Prisma/fakes.ts";
import { json, mockForgejo } from "./support/mock.ts";

/**
 * Resolve credentials through the auth provider and issue one request, so a
 * test asserts on the wire effect of resolution (which instance was reached,
 * which token was sent) rather than on the stored shape alone.
 */
const resolveAndCall = (
  config: Record<string, string>,
  stored?: { baseUrl: string; token: string },
) => {
  const server = mockForgejo((request) =>
    request.path === "/user" ? json({ id: 1, login: "alice" }) : undefined,
  );

  const authProviders: AuthProviders["Service"] = {};
  const layer = fromAuthProvider().pipe(
    Layer.provideMerge(ForgejoAuth),
    Layer.provideMerge(Layer.succeed(AuthProviders, authProviders)),
    Layer.provideMerge(Layer.succeed(ProfileStore, makeFakeProfileStore())),
    Layer.provideMerge(
      Layer.succeed(CredentialsStore, makeFakeCredentialsStore(stored)),
    ),
    Layer.provideMerge(server.layer),
    Layer.provideMerge(
      ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(CliKit.layer({ input: false })),
  );

  return Effect.gen(function* () {
    const resolved = yield* yield* Credentials;
    yield* Services.user.userGetCurrent({});
    return { resolved, server };
  }).pipe(Effect.provide(layer));
};

describe("Forgejo auth provider", () => {
  it.effect("resolves the instance URL and token from a stored profile", () =>
    Effect.gen(function* () {
      const { resolved, server } = yield* resolveAndCall(
        {},
        { baseUrl: "https://git.stored.example", token: "stored-token" },
      );

      // The stored instance URL is what the SDK normalizes and calls.
      expect(resolved.apiBaseUrl).toBe("https://git.stored.example/api/v1");
      expect(Redacted.value(resolved.token)).toBe("stored-token");
      expect(server.count("GET", "/user")).toBe(1);
      expect(server.find("GET", "/user")?.headers.authorization).toBe(
        "token stored-token",
      );
    }),
  );

  it.effect("falls back to FORGEJO_URL and FORGEJO_TOKEN in CI", () =>
    Effect.gen(function* () {
      const { resolved, server } = yield* resolveAndCall({
        CI: "true",
        FORGEJO_URL: "https://git.ci.example",
        FORGEJO_TOKEN: "ci-token",
      });

      expect(resolved.apiBaseUrl).toBe("https://git.ci.example/api/v1");
      expect(server.count("GET", "/user")).toBe(1);
      expect(server.find("GET", "/user")?.headers.authorization).toBe(
        "token ci-token",
      );
    }),
  );

  it.effect("declares both variables as its CI environment contract", () =>
    Effect.gen(function* () {
      const registry: AuthProviders["Service"] = {};
      yield* Layer.build(
        ForgejoAuth.pipe(
          Layer.provideMerge(Layer.succeed(AuthProviders, registry)),
          Layer.provideMerge(
            Layer.succeed(CredentialsStore, makeFakeCredentialsStore()),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(CliKit.layer({ input: false })),
        ),
      );

      const provider = registry.Forgejo;
      expect(provider).toBeDefined();
      expect(provider!.environment.map((v) => v.name)).toEqual([
        "FORGEJO_URL",
        "FORGEJO_TOKEN",
      ]);
      // Only the token is redacted in display surfaces; the URL is not secret.
      expect(provider!.environment.map((v) => v.secret ?? false)).toEqual([
        false,
        true,
      ]);
    }).pipe(Effect.scoped),
  );
});
