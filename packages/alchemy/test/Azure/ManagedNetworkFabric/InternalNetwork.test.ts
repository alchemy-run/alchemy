import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });
const fabricId = process.env.AZURE_NEXUS_FABRIC_ID ?? "";

const get = (
  resourceGroupName: string,
  l3IsolationDomainName: string,
  internalNetworkName: string,
) =>
  Effect.gen(function* () {
    return yield* mnf.GetInternalNetwork({
      subscriptionId: yield* subscription,
      resourceGroupName,
      l3IsolationDomainName,
      internalNetworkName,
    });
  });

const program = (props: { vlanId: number; mtu: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const l3 = yield* Azure.ManagedNetworkFabric.L3IsolationDomain("L3", {
      resourceGroup: group.resourceGroupName,
      networkFabricId: fabricId,
    });
    const res = yield* Azure.ManagedNetworkFabric.InternalNetwork("Internal", {
      resourceGroup: group.resourceGroupName,
      l3IsolationDomain: l3.l3IsolationDomainName,
      vlanId: props.vlanId,
      mtu: props.mtu,
      connectedIPv4Subnets: [{ prefix: "10.1.2.0/24" }],
    });
    return { group, res };
  });

// Needs an Operator Nexus Network Fabric on certified on-premises racks
// (AZURE_NEXUS_FABRIC_ID); the trial cannot create one. ARM configuration
// only once the fabric exists: ~$0, a few minutes.
test.provider.skipIf(!runPaidOnly || !fabricId)(
  "create, update, replace, and delete an internal network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ vlanId: 805, mtu: 1500 }),
      );
      const observed = yield* get(
        group.resourceGroupName,
        res.l3IsolationDomain,
        res.internalNetworkName,
      );
      expect(observed.properties.vlanId).toEqual(805);
      expect(observed.properties.annotation).toContain("alchemy:");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program({ vlanId: 805, mtu: 9000 }));
      expect(updated.res.internalNetworkId).toEqual(res.internalNetworkId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.l3IsolationDomain,
        res.internalNetworkName,
      );
      expect(reobserved.properties.mtu).toEqual(9000);

      // Replacement.
      const replaced = yield* stack.deploy(program({ vlanId: 806, mtu: 9000 }));
      expect(replaced.res.internalNetworkId).not.toEqual(res.internalNetworkId);

      expect(
        yield* waitGone(
          get(
            group.resourceGroupName,
            res.l3IsolationDomain,
            res.internalNetworkName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(
            group.resourceGroupName,
            replaced.res.l3IsolationDomain,
            replaced.res.internalNetworkName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus deployment, so the RP
// rejects the PUT. Only a resource group is created ($0, ~1-2 minutes).
test.provider(
  "an internal network needs an existing L3 isolation domain",
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
        .CreateInternalNetwork({
          subscriptionId,
          resourceGroupName,
          l3IsolationDomainName: "nol3",
          internalNetworkName: "probe",
          properties: { vlanId: 805 },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
