import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getScope = (resourceGroupName: string, scopeName: string) =>
  Effect.gen(function* () {
    return yield* hybridcompute.GetPrivateLinkScope({
      subscriptionId: yield* subscription,
      resourceGroupName,
      scopeName,
    });
  });

const program = (props: {
  name?: string;
  publicNetworkAccess?: "Enabled" | "Disabled";
  serviceExtensions?: Azure.HybridCompute.PrivateLinkScopeServiceExtension[];
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const scope = yield* Azure.HybridCompute.PrivateLinkScope("Scope", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, scope };
  });

// Free, seconds.
test.provider(
  "create, update, replace, and delete a private link scope",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, scope } = yield* stack.deploy(program({}));
      const rg = group.resourceGroupName;
      expect(scope.publicNetworkAccess).toEqual("Disabled");
      expect(scope.privateLinkScopeId).toMatch(/^[0-9a-f-]{36}$/);
      const observed = yield* getScope(rg, scope.privateLinkScopeName);
      expect(observed.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(observed.tags?.["alchemy::id"]).toEqual("Scope");

      // In-place: enable public access and add a tag.
      const updated = yield* stack.deploy(
        program({
          publicNetworkAccess: "Enabled",
          tags: { env: "test" },
        }),
      );
      expect(updated.scope.privateLinkScopeId).toEqual(
        scope.privateLinkScopeId,
      );
      const reobserved = yield* getScope(rg, scope.privateLinkScopeName);
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Enabled");
      expect(reobserved.tags?.env).toEqual("test");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-test-pls-replaced",
          publicNetworkAccess: "Enabled",
          tags: { env: "test" },
        }),
      );
      expect(replaced.scope.privateLinkScopeName).toEqual(
        "alchemy-test-pls-replaced",
      );
      const replacedObserved = yield* getScope(
        rg,
        replaced.scope.privateLinkScopeName,
      );
      expect(replacedObserved.properties?.publicNetworkAccess).toEqual(
        "Enabled",
      );
      expect(yield* waitGone(getScope(rg, scope.privateLinkScopeName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getScope(rg, replaced.scope.privateLinkScopeName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
