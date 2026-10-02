import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });
const fabricId = process.env.AZURE_NEXUS_FABRIC_ID ?? "";
const fabricGroup = fabricId.match(/resourceGroups\/([^/]+)/i)?.[1] ?? "";
const fabricName = fabricId.split("/").pop() ?? "";

const get = (
  resourceGroupName: string,
  networkFabricName: string,
  networkToNetworkInterconnectName: string,
) =>
  Effect.gen(function* () {
    return yield* mnf.GetNetworkToNetworkInterconnect({
      subscriptionId: yield* subscription,
      resourceGroupName,
      networkFabricName,
      networkToNetworkInterconnectName,
    });
  });

const program = (props: { vlanId: number; peerASN: number }) =>
  Effect.gen(function* () {
    const group = { resourceGroupName: fabricGroup };
    const res = yield* Azure.ManagedNetworkFabric.NetworkToNetworkInterconnect(
      "Nni",
      {
        resourceGroup: fabricGroup,
        networkFabric: fabricName,
        nniType: "CE",
        isManagementType: "False",
        useOptionB: "True",
        optionBLayer3Configuration: {
          primaryIpv4Prefix: "10.0.0.12/30",
          secondaryIpv4Prefix: "40.0.0.14/30",
          peerASN: props.peerASN,
          vlanId: props.vlanId,
        },
      },
    );
    return { group, res };
  });

// Needs an Operator Nexus Network Fabric on certified on-premises racks
// (AZURE_NEXUS_FABRIC_ID); the interconnect lives in the fabric's resource group; the trial cannot create one. ARM configuration
// only once the fabric exists: ~$0, a few minutes.
test.provider.skipIf(!runPaidOnly || !fabricId)(
  "create, update, replace, and delete a network-to-network interconnect",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ vlanId: 1234, peerASN: 61234 }),
      );
      const observed = yield* get(
        group.resourceGroupName,
        res.networkFabric,
        res.networkToNetworkInterconnectName,
      );
      expect(observed.properties.optionBLayer3Configuration?.peerASN).toEqual(
        61234,
      );
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(
        program({ vlanId: 1234, peerASN: 61235 }),
      );
      expect(updated.res.networkToNetworkInterconnectId).toEqual(
        res.networkToNetworkInterconnectId,
      );
      const reobserved = yield* get(
        group.resourceGroupName,
        res.networkFabric,
        res.networkToNetworkInterconnectName,
      );
      expect(reobserved.properties.optionBLayer3Configuration?.peerASN).toEqual(
        61235,
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(
            group.resourceGroupName,
            res.networkFabric,
            res.networkToNetworkInterconnectName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus deployment, so the RP
// rejects the PUT. Only a resource group is created ($0, ~1-2 minutes).
test.provider(
  "an interconnect needs an existing Network Fabric",
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
      const subscriptionId = yield* subscription;
      const resourceGroupName = group.resourceGroupName;
      const base = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ManagedNetworkFabric`;
      const error = yield* mnf
        .CreateNetworkToNetworkInterconnect({
          subscriptionId,
          resourceGroupName,
          networkFabricName: "nofabric",
          networkToNetworkInterconnectName: "probe",
          properties: { useOptionB: "True" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
