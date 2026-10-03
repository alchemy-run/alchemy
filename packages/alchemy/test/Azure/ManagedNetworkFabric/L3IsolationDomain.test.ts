import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });
const fabricId = process.env.AZURE_NEXUS_FABRIC_ID ?? "";

const get = (resourceGroupName: string, l3IsolationDomainName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetL3IsolationDomain({
      subscriptionId: yield* subscription,
      resourceGroupName,
      l3IsolationDomainName,
    });
  });

const program = (props: { redistributeStaticRoutes: "True" | "False" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.L3IsolationDomain("L3", {
      resourceGroup: group.resourceGroupName,
      networkFabricId: fabricId,
      redistributeConnectedSubnets: "True",
      redistributeStaticRoutes: props.redistributeStaticRoutes,
    });
    return { group, res };
  });

// Needs an Operator Nexus Network Fabric on certified on-premises racks
// (AZURE_NEXUS_FABRIC_ID); the trial cannot create one. ARM configuration
// only once the fabric exists: ~$0, a few minutes.
test.provider.skipIf(!runPaidOnly || !fabricId)(
  "create, update, and delete an L3 isolation domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ redistributeStaticRoutes: "False" }),
      );
      const observed = yield* get(
        group.resourceGroupName,
        res.l3IsolationDomainName,
      );
      expect(observed.properties.redistributeStaticRoutes).toEqual("False");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(
        program({ redistributeStaticRoutes: "True" }),
      );
      expect(updated.res.l3IsolationDomainId).toEqual(res.l3IsolationDomainId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.l3IsolationDomainName,
      );
      expect(reobserved.properties.redistributeStaticRoutes).toEqual("True");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, res.l3IsolationDomainName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus deployment, so the RP
// rejects the PUT. Only a resource group is created ($0, ~1-2 minutes).
test.provider(
  "the trial rejects an L3 isolation domain without a Network Fabric",
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
        .CreateL3IsolationDomain({
          subscriptionId,
          resourceGroupName,
          l3IsolationDomainName: "probe",
          location: "eastus",
          properties: { networkFabricId: `${base}/networkFabrics/nofabric` },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain("could not be found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
