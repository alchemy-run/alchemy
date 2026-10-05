import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { ensureFeature } from "../features.ts";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

// The Microsoft.Network/AllowInterconnectGroups preview feature needs Microsoft
// approval: self-registration stays `Pending` on a pay-as-you-go subscription. The
// lifecycle registers it and runs with AZURE_TEST_PAID=1 and AZURE_TEST_INTERCONNECT_GROUPS=1
// once approved; otherwise the probe asserts the typed rejection.
const allowListed = !!process.env.AZURE_TEST_INTERCONNECT_GROUPS;

const getGroup = (resourceGroupName: string, interconnectGroupName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetInterconnectGroup({
      subscriptionId,
      resourceGroupName,
      interconnectGroupName,
    }),
  );

// Without the AllowInterconnectGroups feature the resource type is not
// exposed to the subscription: ARM answers `InvalidResourceType` ("The resource type could not be found in
// the namespace 'Microsoft.Network' for api version '2025-09-01'").
test.provider.skipIf(allowListed)(
  "interconnect group creation is rejected without the preview feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* Effect.flatMap(subscriptionId, (subscriptionId) =>
        network.InterconnectGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          interconnectGroupName: "probe",
          location: "eastus",
          properties: {
            scope: "InfiniBand",
            subgroupProfile: {
              vmSize: "Standard_ND96isr_H100_v5",
              scope: "InfiniBand",
              size: 8,
            },
          },
        }),
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const interconnect = yield* Azure.Network.InterconnectGroup("Gpu", {
      resourceGroup: group.resourceGroupName,
      scope: "InfiniBand",
      subgroupProfile: {
        vmSize: "Standard_ND96isr_H100_v5",
        scope: "InfiniBand",
        size: 8,
      },
      tags: props.tags,
    });
    return { group, interconnect };
  });

// Needs a subscription with interconnect-group (GPU InfiniBand) capacity.
// Run with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly || !allowListed)(
  "create, update, and delete an interconnect group",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureFeature("Microsoft.Network", "AllowInterconnectGroups");
      yield* stack.destroy();

      const { group, interconnect } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const observed = yield* getGroup(
        group.resourceGroupName,
        interconnect.interconnectGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      yield* stack.deploy(program({ tags: { env: "prod" } }));
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        interconnect.interconnectGroupName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGroup(group.resourceGroupName, interconnect.interconnectGroupName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
