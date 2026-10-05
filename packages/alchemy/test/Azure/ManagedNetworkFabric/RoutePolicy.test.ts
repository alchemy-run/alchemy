import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });
const fabricId = process.env.AZURE_NEXUS_FABRIC_ID ?? "";

const get = (resourceGroupName: string, routePolicyName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetRoutePolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      routePolicyName,
    });
  });

const program = (props: {
  action: "Permit" | "Deny";
  family: "IPv4" | "IPv6";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const prefix = yield* Azure.ManagedNetworkFabric.IpPrefix("Prefix", {
      resourceGroup: group.resourceGroupName,
      ipPrefixRules: [
        {
          action: "Permit",
          sequenceNumber: 10,
          networkPrefix: props.family === "IPv4" ? "10.0.0.0/8" : "fd00::/8",
        },
      ],
    });
    const res = yield* Azure.ManagedNetworkFabric.RoutePolicy("RoutePolicy", {
      resourceGroup: group.resourceGroupName,
      networkFabricId: fabricId,
      addressFamilyType: props.family,
      statements: [
        {
          sequenceNumber: 10,
          condition: { ipPrefixId: prefix.ipPrefixId },
          action: { actionType: props.action },
        },
      ],
    });
    return { group, res };
  });

// Needs an Operator Nexus Network Fabric on certified on-premises racks
// (AZURE_NEXUS_FABRIC_ID); the trial cannot create one. ARM configuration
// only once the fabric exists: ~$0, a few minutes.
test.provider.skipIf(!runPaidOnly || !fabricId)(
  "create, update, replace, and delete a route policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ action: "Permit", family: "IPv4" }),
      );
      const observed = yield* get(group.resourceGroupName, res.routePolicyName);
      expect(observed.properties.statements[0]?.action.actionType).toEqual(
        "Permit",
      );
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(
        program({ action: "Deny", family: "IPv4" }),
      );
      expect(updated.res.routePolicyId).toEqual(res.routePolicyId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.routePolicyName,
      );
      expect(reobserved.properties.statements[0]?.action.actionType).toEqual(
        "Deny",
      );

      // Replacement.
      const replaced = yield* stack.deploy(
        program({ action: "Deny", family: "IPv6" }),
      );
      expect(replaced.res.routePolicyId).not.toEqual(res.routePolicyId);
      expect(replaced.res.routePolicyId).toContain("routePolicies");
      expect(
        yield* waitGone(get(group.resourceGroupName, res.routePolicyName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.routePolicyName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus deployment, so the RP
// rejects the PUT. Only a resource group is created ($0, ~1-2 minutes).
test.provider(
  "the trial rejects a route policy without a Network Fabric",
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
        .CreateRoutePolicy({
          subscriptionId,
          resourceGroupName,
          routePolicyName: "probe",
          location: "eastus",
          properties: {
            networkFabricId: `${base}/networkFabrics/nofabric`,
            statements: [
              {
                sequenceNumber: 10,
                condition: { ipPrefixId: `${base}/ipPrefixes/noprefix` },
                action: { actionType: "Permit" },
              },
            ],
          },
        })
        .pipe(Effect.flip);
      // ARM code `ResourceCreationValidateFailed`; errors.ts maps it client-wide
      // to the (Datadog-named) DatadogMonitorCreationValidateFailed tag.
      expect(error._tag).toEqual("DatadogMonitorCreationValidateFailed");
      expect(error.message).toContain("could not be found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
