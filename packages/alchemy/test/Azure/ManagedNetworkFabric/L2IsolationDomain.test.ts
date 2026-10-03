import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });
const fabricId = process.env.AZURE_NEXUS_FABRIC_ID ?? "";

const get = (resourceGroupName: string, l2IsolationDomainName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetL2IsolationDomain({
      subscriptionId: yield* subscription,
      resourceGroupName,
      l2IsolationDomainName,
    });
  });

const program = (props: { vlanId: number; mtu: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.L2IsolationDomain("L2", {
      resourceGroup: group.resourceGroupName,
      networkFabricId: fabricId,
      vlanId: props.vlanId,
      mtu: props.mtu,
    });
    return { group, res };
  });

// Needs an Operator Nexus Network Fabric on certified on-premises racks
// (AZURE_NEXUS_FABRIC_ID); the trial cannot create one. ARM configuration
// only once the fabric exists: ~$0, a few minutes.
test.provider.skipIf(!runPaidOnly || !fabricId)(
  "create, update, replace, and delete an L2 isolation domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ vlanId: 750, mtu: 1500 }),
      );
      const observed = yield* get(
        group.resourceGroupName,
        res.l2IsolationDomainName,
      );
      expect(observed.properties.vlanId).toEqual(750);
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program({ vlanId: 750, mtu: 9000 }));
      expect(updated.res.l2IsolationDomainId).toEqual(res.l2IsolationDomainId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.l2IsolationDomainName,
      );
      expect(reobserved.properties.mtu).toEqual(9000);

      // Replacement.
      const replaced = yield* stack.deploy(program({ vlanId: 751, mtu: 9000 }));
      expect(replaced.res.l2IsolationDomainId).not.toEqual(
        res.l2IsolationDomainId,
      );
      expect(replaced.res.l2IsolationDomainName).not.toEqual(
        res.l2IsolationDomainName,
      );
      expect(
        yield* waitGone(
          get(group.resourceGroupName, res.l2IsolationDomainName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.l2IsolationDomainName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus deployment, so the RP
// rejects the PUT. Only a resource group is created ($0, ~1-2 minutes).
test.provider(
  "the trial rejects an L2 isolation domain without a Network Fabric",
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
        .CreateL2IsolationDomain({
          subscriptionId,
          resourceGroupName,
          l2IsolationDomainName: "probe",
          location: "eastus",
          properties: {
            networkFabricId: `${base}/networkFabrics/nofabric`,
            vlanId: 750,
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain("could not be found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
