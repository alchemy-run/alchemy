import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

type Props = Omit<
  Azure.ManagedNetworkFabric.AccessControlListProps,
  "resourceGroup"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.AccessControlList(
      "AccessControlList",
      {
        resourceGroup: group.resourceGroupName,
        ...props,
      },
    );
    return { group, res };
  });

const get = (resourceGroupName: string, accessControlListName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetAccessControlList({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accessControlListName,
    });
  });

const CREATE: Props = {
  configurationType: "Inline",
  defaultAction: "Permit",
  matchConfigurations: [
    {
      matchConfigurationName: "drop-subnet",
      sequenceNumber: 1100,
      ipAddressType: "IPv4",
      matchConditions: [
        {
          ipCondition: {
            type: "SourceIP",
            prefixType: "Prefix",
            ipPrefixValues: ["10.20.0.0/16"],
          },
        },
      ],
      actions: [{ type: "Drop" }],
    },
  ],
  tags: { env: "a" },
};

const UPDATE: Props = {
  configurationType: "Inline",
  defaultAction: "Deny",
  matchConfigurations: [
    {
      matchConfigurationName: "drop-subnet",
      sequenceNumber: 1100,
      ipAddressType: "IPv4",
      matchConditions: [
        {
          ipCondition: {
            type: "SourceIP",
            prefixType: "Prefix",
            ipPrefixValues: ["10.20.0.0/16"],
          },
        },
      ],
      actions: [{ type: "Drop" }],
    },
  ],
  tags: { env: "b" },
};

// ARM configuration object only (no fabric attached): $0, ~1-3 minutes.
test.provider(
  "create, update, replace, and delete an access control list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program(CREATE));
      const observed = yield* get(
        group.resourceGroupName,
        res.accessControlListName,
      );
      expect(observed.properties.defaultAction).toEqual("Permit");
      expect(
        observed.properties.matchConfigurations?.[0]?.matchConfigurationName,
      ).toEqual("drop-subnet");
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("AccessControlList");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program(UPDATE));
      expect(updated.res.accessControlListId).toEqual(res.accessControlListId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.accessControlListName,
      );
      expect(reobserved.properties.defaultAction).toEqual("Deny");
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement.
      const replaced = yield* stack.deploy(
        program({ ...UPDATE, location: "westus3" }),
      );
      expect(replaced.res.accessControlListId).not.toEqual(
        res.accessControlListId,
      );
      expect(replaced.res.location).toEqual("westus3");
      expect(
        yield* waitGone(
          get(group.resourceGroupName, res.accessControlListName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.accessControlListName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
