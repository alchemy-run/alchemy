import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as resourceconnector from "@distilled.cloud/azure/resourceconnector";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getAppliance = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* resourceconnector.GetAppliance({
      subscriptionId,
      resourceGroupName,
      resourceName,
    });
  });

const applianceGone = (resourceGroupName: string, resourceName: string) =>
  getAppliance(resourceGroupName, resourceName).pipe(
    Effect.as("found" as const),
    // A missing appliance returns a bodiless 404 (status-fallback `NotFound`).
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

const program = (props: {
  infrastructureProvider: Azure.ResourceConnector.ApplianceInfrastructureProvider;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const appliance = yield* Azure.ResourceConnector.Appliance("Bridge", {
      resourceGroup: group.resourceGroupName,
      infrastructureProvider: props.infrastructureProvider,
      tags: props.tags,
    });
    return { group, appliance };
  });

// The ARM record is free; it stays in WaitingForHeartbeat because no
// on-premises appliance VM ever connects.
test.provider(
  "create, update tags, replace, and delete an Arc resource bridge",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, appliance } = yield* stack.deploy(
        program({ infrastructureProvider: "HCI", tags: { env: "test" } }),
      );
      expect(appliance.infrastructureProvider).toEqual("HCI");
      expect(appliance.provisioningState).toEqual("Succeeded");
      expect(appliance.applianceId).toContain(
        "/providers/Microsoft.ResourceConnector/appliances/",
      );
      const observed = yield* getAppliance(
        group.resourceGroupName,
        appliance.applianceName,
      );
      expect(observed.properties?.infrastructureConfig?.provider).toEqual(
        "HCI",
      );
      expect(observed.properties?.distro).toEqual("AKSEdge");
      expect(observed.identity?.type).toEqual("SystemAssigned");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Bridge");

      // In-place tag update.
      const updated = yield* stack.deploy(
        program({ infrastructureProvider: "HCI", tags: { env: "prod" } }),
      );
      expect(updated.appliance.applianceName).toEqual(appliance.applianceName);
      expect(updated.appliance.tags).toEqual({ env: "prod" });
      const reobserved = yield* getAppliance(
        group.resourceGroupName,
        appliance.applianceName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Changing the fabric replaces the appliance.
      const replaced = yield* stack.deploy(
        program({ infrastructureProvider: "VMWare", tags: { env: "prod" } }),
      );
      expect(replaced.appliance.infrastructureProvider).toEqual("VMWare");
      expect(replaced.appliance.applianceName).not.toEqual(
        appliance.applianceName,
      );
      expect(
        yield* applianceGone(group.resourceGroupName, appliance.applianceName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* applianceGone(
          group.resourceGroupName,
          replaced.appliance.applianceName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resourceconnector", "live"],
    timeout: 900_000,
  },
);
