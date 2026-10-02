import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  basicRegistry,
  getRegistry,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getScopeMap = (
  resourceGroupName: string,
  registryName: string,
  scopeMapName: string,
) =>
  Effect.gen(function* () {
    return yield* containerregistry.GetScopeMap({
      subscriptionId: yield* subscription,
      resourceGroupName,
      registryName,
      scopeMapName,
    });
  });

const program = (props: {
  name?: string;
  description: string;
  actions: string[];
}) =>
  Effect.gen(function* () {
    const { group, registry } = yield* basicRegistry();
    const scopeMap = yield* Azure.ContainerRegistry.ScopeMap("Scope", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      name: props.name,
      description: props.description,
      actions: props.actions,
    });
    return { group, registry, scopeMap };
  });

// Basic registry (~$0.17/day): well under $1, about a minute.
test.provider(
  "create, update, replace, and delete a scope map",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, scopeMap } = yield* stack.deploy(
        program({
          description: "read app",
          actions: ["repositories/app/content/read"],
        }),
      );
      const get = (name: string) =>
        getScopeMap(group.resourceGroupName, registry.registryName, name);
      expect(scopeMap.scopeMapId).toContain("/scopeMaps/");
      const observed = yield* get(scopeMap.scopeMapName);
      expect(observed.properties?.actions).toEqual([
        "repositories/app/content/read",
      ]);
      expect(observed.properties?.description).toEqual("read app");
      expect(observed.properties?.type).toEqual("UserDefined");

      // In-place: add write access and change the description.
      const updated = yield* stack.deploy(
        program({
          description: "push app",
          actions: [
            "repositories/app/content/read",
            "repositories/app/content/write",
          ],
        }),
      );
      expect(updated.scopeMap.scopeMapId).toEqual(scopeMap.scopeMapId);
      const reobserved = yield* get(scopeMap.scopeMapName);
      expect([...(reobserved.properties?.actions ?? [])].sort()).toEqual([
        "repositories/app/content/read",
        "repositories/app/content/write",
      ]);
      expect(reobserved.properties?.description).toEqual("push app");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemyscopemaptest",
          description: "push app",
          actions: ["repositories/app/content/read"],
        }),
      );
      expect(replaced.scopeMap.scopeMapName).toEqual("alchemyscopemaptest");
      const replacedObserved = yield* get("alchemyscopemaptest");
      expect(replacedObserved.properties?.actions).toEqual([
        "repositories/app/content/read",
      ]);
      expect(yield* waitGone(get(scopeMap.scopeMapName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, registry.registryName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
