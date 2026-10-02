import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as appconfiguration from "@distilled.cloud/azure/appconfiguration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getReplica = (
  resourceGroupName: string,
  configStoreName: string,
  replicaName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* appconfiguration.GetReplicas({
      subscriptionId,
      resourceGroupName,
      configStoreName,
      replicaName,
    });
  });

const replicaGone = (
  resourceGroupName: string,
  configStoreName: string,
  replicaName: string,
) =>
  getReplica(resourceGroupName, configStoreName, replicaName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (replicaLocation: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const store = yield* Azure.AppConfiguration.ConfigurationStore("Config", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const replica = yield* Azure.AppConfiguration.Replica("Replica", {
      resourceGroup: group.resourceGroupName,
      configurationStore: store.configurationStoreName,
      location: replicaLocation,
    });
    return { group, store, replica };
  });

// Standard store + replica: ~$0.05/hour each, prorated (a run takes
// ~5-10 minutes).
test.provider(
  "create, replace, and delete a configuration store replica",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, store, replica } = yield* stack.deploy(program("westus2"));
      expect(replica.replicaName).toMatch(/^[a-z0-9]{1,50}$/);
      expect(replica.location.toLowerCase()).toEqual("westus2");
      expect(replica.endpoint).toContain(store.configurationStoreName);
      const observed = yield* getReplica(
        group.resourceGroupName,
        store.configurationStoreName,
        replica.replicaName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // Replacement: a new location.
      const moved = yield* stack.deploy(program("centralus"));
      expect(moved.replica.replicaName).not.toEqual(replica.replicaName);
      expect(moved.replica.location.toLowerCase()).toEqual("centralus");
      expect(
        yield* replicaGone(
          group.resourceGroupName,
          store.configurationStoreName,
          replica.replicaName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* replicaGone(
          group.resourceGroupName,
          store.configurationStoreName,
          moved.replica.replicaName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:appconfiguration", "live"],
    timeout: 900_000,
  },
);
