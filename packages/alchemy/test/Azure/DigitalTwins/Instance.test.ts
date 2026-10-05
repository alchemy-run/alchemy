import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as digitaltwins from "@distilled.cloud/azure/digitaltwins";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getInstance = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    return yield* digitaltwins.GetDigitalTwin({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
    });
  });

const program = (props: {
  location: string;
  publicNetworkAccess: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const instance = yield* Azure.DigitalTwins.Instance("Twins", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      identity: { type: "SystemAssigned" },
      publicNetworkAccess: props.publicNetworkAccess,
      tags: props.tags,
    });
    return { group, instance };
  });

// Digital Twins has no hourly fee (billed per operation): ~$0 per run,
// 1-3 minutes per instance create/delete.
test.provider(
  "create, update, replace, and delete a Digital Twins instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance } = yield* stack.deploy(
        program({
          location: "eastus",
          publicNetworkAccess: "Enabled",
          tags: { env: "test" },
        }),
      );
      const get = (name: string) => getInstance(group.resourceGroupName, name);
      expect(instance.hostName).toContain(".digitaltwins.azure.net");
      expect(instance.identityType).toEqual("SystemAssigned");
      expect(instance.principalId).toBeTruthy();
      const observed = yield* get(instance.instanceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.publicNetworkAccess).toEqual("Enabled");
      expect(observed.identity?.principalId).toEqual(instance.principalId);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Twins");

      // In-place: disable public access and change tags.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.instance.instanceId).toEqual(instance.instanceId);
      expect(updated.instance.publicNetworkAccess).toEqual("Disabled");
      expect(updated.instance.tags).toEqual({ env: "prod" });
      const reobserved = yield* get(instance.instanceName);
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.createdTime).toEqual(
        observed.properties?.createdTime,
      );

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.instance.instanceName).not.toEqual(instance.instanceName);
      const replacedObserved = yield* get(replaced.instance.instanceName);
      expect(replacedObserved.location.toLowerCase()).toEqual("westus2");
      expect(yield* waitGone(get(instance.instanceName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.instance.instanceName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
