import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { getNamespace, gone, logLevel, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { location: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const ns = yield* Azure.NotificationHubs.Namespace("Push", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      sku: "Free",
      tags: props.tags,
    });
    return { group, ns };
  });

// Free-tier namespace: $0; a few minutes per run.
test.provider(
  "create, update, replace, and delete a notification hubs namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns } = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(ns.namespaceName).toMatch(/^[a-z][a-z0-9-]{4,48}[a-z0-9]$/);
      expect(ns.sku).toEqual("Free");
      expect(ns.serviceBusEndpoint).toContain(
        `${ns.namespaceName}.servicebus.windows.net`,
      );
      expect(ns.tags).toEqual({ env: "test" });
      expect(ns.primaryConnectionString).toBeDefined();
      expect(Redacted.value(ns.primaryConnectionString!)).toContain(
        `Endpoint=sb://${ns.namespaceName}.servicebus.windows.net/`,
      );
      const observed = yield* getNamespace(rg, ns.namespaceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.sku.name).toEqual("Free");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Push");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "prod" } }),
      );
      expect(updated.ns.namespaceName).toEqual(ns.namespaceName);
      expect(updated.ns.tags).toEqual({ env: "prod" });
      const reobserved = yield* getNamespace(rg, ns.namespaceName);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: location is immutable.
      const replaced = yield* stack.deploy(
        program({ location: "westus2", tags: { env: "prod" } }),
      );
      expect(replaced.ns.namespaceName).not.toEqual(ns.namespaceName);
      expect(replaced.ns.location.toLowerCase().replace(/\s/g, "")).toEqual(
        "westus2",
      );
      expect(yield* gone(getNamespace(rg, ns.namespaceName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* gone(getNamespace(rg, replaced.ns.namespaceName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
