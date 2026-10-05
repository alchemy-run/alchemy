import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

type Props = Omit<Azure.ManagedNetworkFabric.IpCommunityProps, "resourceGroup">;

const program = (props: Props) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.IpCommunity("IpCommunity", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, res };
  });

const get = (resourceGroupName: string, ipCommunityName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetIpCommunity({
      subscriptionId: yield* subscription,
      resourceGroupName,
      ipCommunityName,
    });
  });

const CREATE: Props = {
  ipCommunityRules: [
    { action: "Permit", sequenceNumber: 10, communityMembers: ["65000:100"] },
  ],
  tags: { env: "a" },
};

const UPDATE: Props = {
  ipCommunityRules: [
    { action: "Permit", sequenceNumber: 10, communityMembers: ["65000:100"] },
    { action: "Deny", sequenceNumber: 20, communityMembers: ["65000:200"] },
  ],
  tags: { env: "b" },
};

// ARM configuration object only (no fabric attached): $0, ~1-3 minutes.
test.provider(
  "create, update, replace, and delete an IP community list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program(CREATE));
      const observed = yield* get(group.resourceGroupName, res.ipCommunityName);
      expect(observed.properties.ipCommunityRules).toMatchObject(
        CREATE.ipCommunityRules,
      );
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("IpCommunity");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program(UPDATE));
      expect(updated.res.ipCommunityId).toEqual(res.ipCommunityId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.ipCommunityName,
      );
      expect(reobserved.properties.ipCommunityRules).toMatchObject(
        UPDATE.ipCommunityRules,
      );
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement.
      const replaced = yield* stack.deploy(
        program({ ...UPDATE, location: "westus3" }),
      );
      expect(replaced.res.ipCommunityId).not.toEqual(res.ipCommunityId);
      expect(replaced.res.location).toEqual("westus3");
      expect(
        yield* waitGone(get(group.resourceGroupName, res.ipCommunityName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.ipCommunityName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
