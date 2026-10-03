import * as Azure from "@/Azure";
import * as AdoptPolicy from "@/AdoptPolicy";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });
const fabricId = process.env.AZURE_NEXUS_FABRIC_ID ?? "";
// A packet broker the RP created with the fabric: `<resourceGroup>/<name>`.
const [brokerGroup = "", brokerName = ""] = (
  process.env.AZURE_NEXUS_PACKET_BROKER ?? ""
).split("/");

const get = (resourceGroupName: string, networkPacketBrokerName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetNetworkPacketBroker({
      subscriptionId: yield* subscription,
      resourceGroupName,
      networkPacketBrokerName,
    });
  });

const program = (env: string) =>
  Effect.gen(function* () {
    const res = yield* Azure.ManagedNetworkFabric.NetworkPacketBroker("NPB", {
      resourceGroup: brokerGroup,
      name: brokerName,
      location: "eastus",
      networkFabricId: fabricId,
      tags: { env },
    }).pipe(AdoptPolicy.adopt());
    return { res };
  });

// Packet brokers are created by the RP when an Operator Nexus Network Fabric
// with NPB devices is provisioned (AZURE_NEXUS_FABRIC_ID,
// AZURE_NEXUS_PACKET_BROKER); the trial cannot create one. The test adopts
// the broker, syncs its tags, and deletes it: ARM configuration only, ~$0,
// a few minutes.
test.provider.skipIf(!runPaidOnly || !fabricId || !brokerName)(
  "adopt, update, and delete a network packet broker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { res } = yield* stack.deploy(program("one"));
      const observed = yield* get(brokerGroup, res.networkPacketBrokerName);
      expect(observed.properties.networkFabricId.toLowerCase()).toEqual(
        fabricId.toLowerCase(),
      );
      expect(observed.tags?.env).toEqual("one");

      // In place: tags.
      const updated = yield* stack.deploy(program("two"));
      expect(updated.res.networkPacketBrokerId).toEqual(
        res.networkPacketBrokerId,
      );
      const reobserved = yield* get(brokerGroup, res.networkPacketBrokerName);
      expect(reobserved.tags?.env).toEqual("two");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(brokerGroup, res.networkPacketBrokerName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the RP never accepts a user PUT of a packet broker. Only a
// resource group is created ($0, ~1-2 minutes).
test.provider(
  "the RP rejects creating a network packet broker directly",
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
        .CreateNetworkPacketBroker({
          subscriptionId,
          resourceGroupName,
          networkPacketBrokerName: "probe",
          location: "eastus",
          properties: { networkFabricId: `${base}/networkFabrics/nofabric` },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain("PUT not allowed");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
