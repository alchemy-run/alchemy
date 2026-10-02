import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });
const controllerId = process.env.AZURE_NEXUS_NFC_ID ?? "";
const terminalServerPassword = process.env.AZURE_NEXUS_TS_PASSWORD ?? "";

const get = (resourceGroupName: string, networkFabricName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetNetworkFabric({
      subscriptionId: yield* subscription,
      resourceGroupName,
      networkFabricName,
    });
  });

const program = (props: { annotation: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.NetworkFabric("Fabric", {
      resourceGroup: group.resourceGroupName,
      networkFabricControllerId: controllerId,
      networkFabricSku: "M4-A400-A100-C16-aa",
      fabricVersion: "7.0.0",
      rackCount: 4,
      serverCountPerRack: 8,
      ipv4Prefix: "10.18.0.0/19",
      fabricASN: 65048,
      annotation: props.annotation,
      terminalServerConfiguration: {
        username: "admin",
        password: terminalServerPassword,
        primaryIpv4Prefix: "10.0.0.12/30",
        secondaryIpv4Prefix: "20.0.0.12/30",
      },
      managementNetworkConfiguration: {
        infrastructureVpnConfiguration: {
          peeringOption: "OptionB",
          optionBProperties: {
            routeTargets: {
              importIpv4RouteTargets: ["65048:1"],
              exportIpv4RouteTargets: ["65048:1"],
            },
          },
        },
        workloadVpnConfiguration: {
          peeringOption: "OptionB",
          optionBProperties: {
            routeTargets: {
              importIpv4RouteTargets: ["65048:2"],
              exportIpv4RouteTargets: ["65048:2"],
            },
          },
        },
      },
    });
    return { group, res };
  });

// Needs a provisioned Network Fabric Controller (AZURE_NEXUS_NFC_ID) and
// Operator Nexus racks. Creating the fabric resource itself is ARM metadata
// (provisioning is a separate action): ~$0, a few minutes.
// There is no cheap rejection probe: the trial accepts the PUT even with a
// nonexistent controller (provisioningState stays `Accepted`).
test.provider.skipIf(!runPaidOnly || !controllerId)(
  "create, update, and delete a network fabric",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program({ annotation: "a" }));
      const observed = yield* get(
        group.resourceGroupName,
        res.networkFabricName,
      );
      expect(observed.properties.annotation).toEqual("a");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program({ annotation: "b" }));
      expect(updated.res.networkFabricId).toEqual(res.networkFabricId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.networkFabricName,
      );
      expect(reobserved.properties.annotation).toEqual("b");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(group.resourceGroupName, res.networkFabricName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
