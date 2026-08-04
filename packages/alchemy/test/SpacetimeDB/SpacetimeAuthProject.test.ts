import * as Provider from "@/Provider.ts";
import {
  SpacetimeAuthProject,
  SpacetimeAuthProjectProvider,
} from "@/SpacetimeDB/SpacetimeAuth.ts";
import { AlchemyContext } from "@/AlchemyContext.ts";
import { InstanceId } from "@/InstanceId.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const providerLayer = Layer.mergeAll(
  SpacetimeAuthProjectProvider(),
  Layer.succeed(Stage, "test"),
  Layer.succeed(Stack, {
    name: "test",
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  }),
  Layer.succeed(AlchemyContext, {
    dev: false,
    adopt: false,
    dotAlchemy: ".alchemy",
  }),
  Layer.succeed(InstanceId, "0123456789abcdef0123456789abcdef"),
  NodeServices.layer,
);

const baseProps = {
  projectName: "my-game",
  clientId: "client-abc",
  issuer: "https://auth.spacetimedb.com/my-game",
};

describe("SpacetimeAuthProject", () => {
  it("exposes the renamed resource type and aliases", () => {
    expect(SpacetimeAuthProject.Type).toBe("SpacetimeDB.SpacetimeAuthProject");
    expect(SpacetimeAuthProject.Aliases).toContain("SpacetimeDB.SpacetimeAuth");
  });

  it.effect("diff returns replace when physical-identity props change", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(SpacetimeAuthProject);
      const result = yield* provider.diff!({
        id: "Auth",
        fqn: "Auth",
        instanceId: "x",
        news: { ...baseProps, clientId: "new" },
        olds: baseProps,
        output: undefined,
        bindings: [],
      } as any);
      expect(result).toEqual({ action: "replace" });
    }).pipe(Effect.provide(providerLayer)),
  );

  it.effect("diff returns replace when issuer changes", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(SpacetimeAuthProject);
      const result = yield* provider.diff!({
        id: "Auth",
        fqn: "Auth",
        instanceId: "x",
        news: { ...baseProps, issuer: "https://other.com/p" },
        olds: baseProps,
        output: undefined,
        bindings: [],
      } as any);
      expect(result).toEqual({ action: "replace" });
    }).pipe(Effect.provide(providerLayer)),
  );

  it.effect("diff returns update when only redirectUris change", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(SpacetimeAuthProject);
      const result = yield* provider.diff!({
        id: "Auth",
        fqn: "Auth",
        instanceId: "x",
        news: {
          ...baseProps,
          redirectUris: ["http://localhost:5173/callback"],
        },
        olds: baseProps,
        output: undefined,
        bindings: [],
      } as any);
      expect(result).toEqual({ action: "update" });
    }).pipe(Effect.provide(providerLayer)),
  );

  it.effect("reconcile dies on blank clientId", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(SpacetimeAuthProject);
      const result = yield* Effect.exit(
        provider.reconcile!({
          id: "Auth",
          fqn: "Auth",
          instanceId: "x",
          news: { ...baseProps, clientId: "" },
          olds: baseProps,
          output: undefined,
          bindings: [],
        } as any),
      );
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(providerLayer)),
  );

  it.effect("reconcile returns trimmed issuer + default scopes", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(SpacetimeAuthProject);
      const out = yield* provider.reconcile!({
        id: "Auth",
        fqn: "Auth",
        instanceId: "x",
        news: { ...baseProps, issuer: "https://auth.spacetimedb.com/my-game/" },
        olds: baseProps,
        output: undefined,
        bindings: [],
      } as any);
      expect(out.issuer).toBe("https://auth.spacetimedb.com/my-game");
      expect(out.scopes).toEqual(["openid", "profile"]);
      expect(out.openIdConfigUrl).toBe(
        "https://auth.spacetimedb.com/my-game/.well-known/openid-configuration",
      );
      expect(out.dashboardUrl).toContain("project=");
    }).pipe(Effect.provide(providerLayer)),
  );
});
