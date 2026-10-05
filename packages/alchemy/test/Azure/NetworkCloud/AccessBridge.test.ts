import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as nc from "@distilled.cloud/azure/networkcloud";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  bogusCustomLocation,
  customLocationId,
  logLevel,
  nexus,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const get = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* nc.GetAccessBridge({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accessBridgeName: name,
    });
  });

const program = (props: { port: string; vlan: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const network = yield* Azure.NetworkCloud.L3Network("Network", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      customLocationId,
      l3IsolationDomainId: nexus.l3IsolationDomainId,
      vlan: props.vlan,
      ipAllocationType: "IPV4",
      ipv4ConnectedPrefix: `10.${props.vlan % 250}.0.0/24`,
    });
    const res = yield* Azure.NetworkCloud.AccessBridge("Bridge", {
      resourceGroup: group.resourceGroupName,
      name: "Bastion",
      location: "eastus",
      customLocationId,
      networkId: network.l3NetworkId,
      securityRules: [
        {
          direction: "Inbound",
          port: props.port,
          ipv4Addresses: ["10.0.0.0/8"],
        },
      ],
    });
    return { group, res };
  });

// Needs a deployed Operator Nexus cluster on certified on-premises racks
// (AZURE_NEXUS_CUSTOM_LOCATION_ID, AZURE_NEXUS_L3_ISOLATION_DOMAIN_ID); the trial cannot create one.
// Billed as part of the Nexus cluster; a few minutes once the cluster exists.
test.provider.skipIf(
  !runPaidOnly || !customLocationId || !nexus.l3IsolationDomainId,
)(
  "create, update, and delete a Nexus access bridge",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ port: "22", vlan: 1011 }),
      );
      const observed = yield* get(
        group.resourceGroupName,
        res.accessBridgeName,
      );
      expect(observed.properties.securityRules?.[0]?.port).toEqual("22");

      // In place.
      const updated = yield* stack.deploy(
        program({ port: "2222", vlan: 1011 }),
      );
      expect(updated.res.accessBridgeId).toEqual(res.accessBridgeId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.accessBridgeName,
      );
      expect(reobserved.properties.securityRules?.[0]?.port).toEqual("2222");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, updated.res.accessBridgeName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus cluster, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1 minute).
test.provider(
  "the trial rejects a Nexus access bridge without a cluster custom location",
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
      const pre = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers`;
      const error = yield* nc
        .AccessBridgesCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          location: "eastus",
          accessBridgeName: "Bastion",
          extendedLocation: bogusCustomLocation(
            subscriptionId,
            resourceGroupName,
          ),
          properties: {
            networkId: `${pre}/Microsoft.NetworkCloud/l3Networks/nonet`,
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      expect(error.message).toContain("custom location was not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
