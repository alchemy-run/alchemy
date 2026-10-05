import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mission from "@distilled.cloud/azure/mission";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  LIFECYCLE_TIMEOUT,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCommunity = (resourceGroupName: string, communityName: string) =>
  Effect.gen(function* () {
    return yield* mission.GetCommunity({
      subscriptionId: yield* subscription,
      resourceGroupName,
      communityName,
    });
  });

const program = (props: {
  dnsServers?: string[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const community = yield* Azure.VirtualEnclaves.Community("Community", {
      resourceGroup: group.resourceGroupName,
      addressSpace: "10.20.0.0/16",
      // Azure provisions Standard even when Basic is requested.
      firewallSku: "Standard",
      ...props,
    });
    return { group, community };
  });

// A community deploys a Virtual WAN hub (~$0.25/h) and a Standard Azure
// Firewall (~$1.25/h) and takes 30-60+ minutes to create and to delete:
// ~$1.5-3 and up to two hours per run. Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a virtual enclaves community",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, community } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(community.provisioningState).toEqual("Succeeded");
      expect(community.managedResourceGroupName).toBeDefined();
      const observed = yield* getCommunity(
        group.resourceGroupName,
        community.communityName,
      );
      expect(observed.properties?.firewallSku).toEqual("Standard");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Community");

      // In-place: DNS servers and tags.
      const updated = yield* stack.deploy(
        program({ dnsServers: ["10.20.0.4"], tags: { env: "prod" } }),
      );
      expect(updated.community.communityId).toEqual(community.communityId);
      const after = yield* getCommunity(
        group.resourceGroupName,
        community.communityName,
      );
      expect(after.properties?.dnsServers).toEqual(["10.20.0.4"]);
      expect(after.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCommunity(group.resourceGroupName, community.communityName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: LIFECYCLE_TIMEOUT },
);
