import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as aci from "@distilled.cloud/azure/containerinstance";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getNGroup = (resourceGroupName: string, ngroupsName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* aci.GetNGroup({
      subscriptionId,
      resourceGroupName,
      ngroupsName,
    });
  });

const nGroupGone = (resourceGroupName: string, name: string) =>
  getNGroup(resourceGroupName, name).pipe(
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

/** Container groups in the resource group (those the NGroup created). */
const listGroups = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* aci.ListContainerGroupByResourceGroup({
      subscriptionId,
      resourceGroupName,
    });
    return page.value ?? [];
  });

const program = (props: {
  desiredCount: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const profile = yield* Azure.ContainerInstance.ContainerGroupProfile(
      "Profile",
      {
        resourceGroup: group.resourceGroupName,
        containers: [
          {
            name: "web",
            image: "mcr.microsoft.com/azuredocs/aci-helloworld",
            cpu: 0.5,
            memoryInGB: 0.5,
          },
        ],
      },
    );
    const fleet = yield* Azure.ContainerInstance.NGroup("Fleet", {
      resourceGroup: group.resourceGroupName,
      desiredCount: props.desiredCount,
      containerGroupProfiles: [
        { id: profile.containerGroupProfileId, revision: profile.revision },
      ],
      tags: props.tags,
    });
    return { group, profile, fleet };
  });

// 1-2 container groups of 0.5 vCPU / 0.5 GB for a few minutes: < $0.05.
test.provider(
  "create, scale, and delete an NGroup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, fleet } = yield* stack.deploy(
        program({ desiredCount: 1, tags: { env: "test" } }),
      );
      expect(fleet.desiredCount).toEqual(1);
      const observed = yield* getNGroup(
        group.resourceGroupName,
        fleet.nGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect((yield* listGroups(group.resourceGroupName)).length).toEqual(1);

      // In place: scale out and retag.
      const scaled = yield* stack.deploy(
        program({ desiredCount: 2, tags: { env: "prod" } }),
      );
      expect(scaled.fleet.nGroupId).toEqual(fleet.nGroupId);
      expect(scaled.fleet.desiredCount).toEqual(2);
      const reobserved = yield* getNGroup(
        group.resourceGroupName,
        fleet.nGroupName,
      );
      expect(reobserved.properties?.elasticProfile?.desiredCount).toEqual(2);
      expect(reobserved.tags?.env).toEqual("prod");
      const groups = yield* listGroups(group.resourceGroupName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (groups) => groups.length === 2,
          times: 24,
        }),
      );
      expect(groups.length).toEqual(2);

      yield* stack.destroy();
      expect(
        yield* nGroupGone(group.resourceGroupName, fleet.nGroupName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerinstance", "live"],
    timeout: 900_000,
  },
);
