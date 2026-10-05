import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

type Props = Omit<
  Azure.ManagedNetworkFabric.IpExtendedCommunityProps,
  "resourceGroup"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.IpExtendedCommunity(
      "IpExtendedCommunity",
      {
        resourceGroup: group.resourceGroupName,
        ...props,
      },
    );
    return { group, res };
  });

const get = (resourceGroupName: string, ipExtendedCommunityName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetIpExtendedCommunity({
      subscriptionId: yield* subscription,
      resourceGroupName,
      ipExtendedCommunityName,
    });
  });

const CREATE: Props = {
  ipExtendedCommunityRules: [
    { action: "Permit", sequenceNumber: 10, routeTargets: ["65000:100"] },
  ],
  tags: { env: "a" },
};

const UPDATE: Props = {
  ipExtendedCommunityRules: [
    { action: "Permit", sequenceNumber: 10, routeTargets: ["65000:100"] },
    { action: "Deny", sequenceNumber: 20, routeTargets: ["65000:200"] },
  ],
  annotation: "updated",
  tags: { env: "b" },
};

// ARM configuration object only (no fabric attached): $0, ~1-3 minutes.
test.provider(
  "create, update, replace, and delete an IP extended community list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program(CREATE));
      const observed = yield* get(
        group.resourceGroupName,
        res.ipExtendedCommunityName,
      );
      expect(observed.properties.ipExtendedCommunityRules).toMatchObject(
        CREATE.ipExtendedCommunityRules,
      );
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("IpExtendedCommunity");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program(UPDATE));
      expect(updated.res.ipExtendedCommunityId).toEqual(
        res.ipExtendedCommunityId,
      );
      const reobserved = yield* get(
        group.resourceGroupName,
        res.ipExtendedCommunityName,
      );
      expect(reobserved.properties.ipExtendedCommunityRules).toMatchObject(
        UPDATE.ipExtendedCommunityRules,
      );
      expect(reobserved.properties.annotation).toEqual("updated");
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement.
      const replaced = yield* stack.deploy(
        program({ ...UPDATE, location: "westus3" }),
      );
      expect(replaced.res.ipExtendedCommunityId).not.toEqual(
        res.ipExtendedCommunityId,
      );
      expect(replaced.res.location).toEqual("westus3");
      expect(
        yield* waitGone(
          get(group.resourceGroupName, res.ipExtendedCommunityName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.ipExtendedCommunityName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
