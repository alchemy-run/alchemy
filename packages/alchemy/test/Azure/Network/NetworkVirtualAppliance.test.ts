import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNva = (
  resourceGroupName: string,
  networkVirtualApplianceName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkVirtualAppliance({
      subscriptionId,
      resourceGroupName,
      networkVirtualApplianceName,
    }),
  );

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, hub } = yield* standardHub;
    const nva = yield* Azure.Network.NetworkVirtualAppliance("Nva", {
      resourceGroup: group.resourceGroupName,
      virtualHubId: hub.virtualHubId,
      nvaSku: {
        vendor: "barracudasdwanrelease",
        bundledScaleUnit: "2",
        marketPlaceVersion: "latest",
      },
      virtualApplianceAsn: 64512,
      tags: props.tags,
    });
    return { group, hub, nva };
  });

// Marketplace NVA in a Standard hub: the trial blocks marketplace offers,
// the hub bills ~$0.25/hour plus the vendor's licence, and deployment
// takes 30+ minutes. No cheap ungated probe exists: Azure validates the
// referenced hub before the marketplace offer ("Nva's referenced
// VirtualHub was not found"). Run with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a network virtual appliance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, nva } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const observed = yield* getNva(
        group.resourceGroupName,
        nva.networkVirtualApplianceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      yield* stack.deploy(program({ tags: { env: "prod" } }));
      const reobserved = yield* getNva(
        group.resourceGroupName,
        nva.networkVirtualApplianceName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getNva(group.resourceGroupName, nva.networkVirtualApplianceName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
