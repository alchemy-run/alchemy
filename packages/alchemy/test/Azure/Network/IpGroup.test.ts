import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getIpGroup = (resourceGroupName: string, ipGroupsName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetIpGroup({ subscriptionId, resourceGroupName, ipGroupsName }),
  );

// IP groups are free.
const program = (props: {
  ipAddresses: string[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const ipGroup = yield* Azure.Network.IpGroup("OnPrem", {
      resourceGroup: group.resourceGroupName,
      ipAddresses: props.ipAddresses,
      tags: props.tags,
    });
    return { group, ipGroup };
  });

test.provider(
  "create, update, and delete an IP group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ipGroup } = yield* stack.deploy(
        program({ ipAddresses: ["10.10.0.0/16"], tags: { env: "test" } }),
      );
      expect(ipGroup.ipAddresses).toEqual(["10.10.0.0/16"]);
      const observed = yield* getIpGroup(
        group.resourceGroupName,
        ipGroup.ipGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({
          ipAddresses: ["10.10.0.0/16", "192.168.1.4"],
          tags: { env: "prod" },
        }),
      );
      expect(updated.ipGroup.ipGroupId).toEqual(ipGroup.ipGroupId);
      const reobserved = yield* getIpGroup(
        group.resourceGroupName,
        ipGroup.ipGroupName,
      );
      expect([...(reobserved.properties?.ipAddresses ?? [])].sort()).toEqual([
        "10.10.0.0/16",
        "192.168.1.4",
      ]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getIpGroup(group.resourceGroupName, ipGroup.ipGroupName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
