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
  externalNetworkName: string,
) =>
  Effect.gen(function* () {
    return yield* mnf.GetExternalNetwork({
      subscriptionId: yield* subscription,
      resourceGroupName,
      l3IsolationDomainName,
      externalNetworkName,
    });
  });

const program = (props: {
  peeringOption: "OptionA" | "OptionB";
  target: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const l3 = yield* Azure.ManagedNetworkFabric.L3IsolationDomain("L3", {
      resourceGroup: group.resourceGroupName,
      networkFabricId: fabricId,
    });
    const res = yield* Azure.ManagedNetworkFabric.ExternalNetwork("External", {
      resourceGroup: group.resourceGroupName,
      l3IsolationDomain: l3.l3IsolationDomainName,
      peeringOption: props.peeringOption,
      optionBProperties:
        props.peeringOption === "OptionB"
          ? {
              routeTargets: {
                importIpv4RouteTargets: [props.target],
                exportIpv4RouteTargets: [props.target],
              },
            }
          : undefined,
      optionAProperties:
        props.peeringOption === "OptionA"
          ? {
              vlanId: 1001,
              peerASN: 65047,
              primaryIpv4Prefix: "10.1.1.0/31",
              secondaryIpv4Prefix: "10.1.1.2/31",
            }
          : undefined,
    });
    return { group, res };
  });

// Needs an Operator Nexus Network Fabric on certified on-premises racks
// (AZURE_NEXUS_FABRIC_ID); the trial cannot create one. ARM configuration
// only once the fabric exists: ~$0, a few minutes.
test.provider.skipIf(!runPaidOnly || !fabricId)(
  "create, update, replace, and delete an external network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ peeringOption: "OptionB", target: "65046:10039" }),
      );
      const observed = yield* get(
        group.resourceGroupName,
        res.l3IsolationDomain,
        res.externalNetworkName,
      );
      expect(observed.properties.peeringOption).toEqual("OptionB");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(
        program({ peeringOption: "OptionB", target: "65046:10040" }),
      );
      expect(updated.res.externalNetworkId).toEqual(res.externalNetworkId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.l3IsolationDomain,
        res.externalNetworkName,
      );
      expect(
        reobserved.properties.optionBProperties?.routeTargets
          ?.importIpv4RouteTargets,
      ).toEqual(["65046:10040"]);

      // Replacement.
      const replaced = yield* stack.deploy(
        program({ peeringOption: "OptionA", target: "65046:10040" }),
      );
      expect(replaced.res.externalNetworkId).not.toEqual(res.externalNetworkId);

      expect(
        yield* waitGone(
          get(
            group.resourceGroupName,
            res.l3IsolationDomain,
            res.externalNetworkName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(
            group.resourceGroupName,
            replaced.res.l3IsolationDomain,
            replaced.res.externalNetworkName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus deployment, so the RP
// rejects the PUT. Only a resource group is created ($0, ~1-2 minutes).
test.provider(
  "an external network needs an existing L3 isolation domain",
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
        .CreateExternalNetwork({
          subscriptionId,
          resourceGroupName,
          l3IsolationDomainName: "nol3",
          externalNetworkName: "probe",
          properties: { peeringOption: "OptionB" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
