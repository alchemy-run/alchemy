import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });
const infraCircuitId = process.env.AZURE_NEXUS_INFRA_ER_CIRCUIT_ID ?? "";
const infraKey = process.env.AZURE_NEXUS_INFRA_ER_AUTH_KEY ?? "";
const workloadCircuitId = process.env.AZURE_NEXUS_WORKLOAD_ER_CIRCUIT_ID ?? "";
const workloadKey = process.env.AZURE_NEXUS_WORKLOAD_ER_AUTH_KEY ?? "";

const get = (resourceGroupName: string, networkFabricControllerName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetNetworkFabricController({
      subscriptionId: yield* subscription,
      resourceGroupName,
      networkFabricControllerName,
    });
  });

const program = (props: { env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.NetworkFabricController(
      "Nfc",
      {
        resourceGroup: group.resourceGroupName,
        ipv4AddressSpace: "10.0.0.0/19",
        nfcSku: "Standard",
        infrastructureExpressRouteConnections: [
          {
            expressRouteCircuitId: infraCircuitId,
            expressRouteAuthorizationKey: infraKey,
          },
        ],
        workloadExpressRouteConnections: [
          {
            expressRouteCircuitId: workloadCircuitId,
            expressRouteAuthorizationKey: workloadKey,
          },
        ],
        tags: { env: props.env },
      },
    );
    return { group, res };
  });

// Needs two ExpressRoute circuits connected to an Operator Nexus site
// (AZURE_NEXUS_*_ER_*). Provisioning takes 45-90 minutes and the controller
// bills hourly. The trial accepts the PUT with bogus circuits but cannot
// provision it, so there is no cheap rejection probe.
test.provider.skipIf(!runPaidOnly || !infraCircuitId)(
  "create, update, and delete a network fabric controller",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program({ env: "a" }));
      const observed = yield* get(
        group.resourceGroupName,
        res.networkFabricControllerName,
      );
      expect(observed.properties.ipv4AddressSpace).toEqual("10.0.0.0/19");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program({ env: "b" }));
      expect(updated.res.networkFabricControllerId).toEqual(
        res.networkFabricControllerId,
      );
      const reobserved = yield* get(
        group.resourceGroupName,
        res.networkFabricControllerName,
      );
      expect(reobserved.tags?.env).toEqual("b");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, res.networkFabricControllerName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
