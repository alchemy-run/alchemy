import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

type Props = Omit<
  Azure.ManagedNetworkFabric.NeighborGroupProps,
  "resourceGroup"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.NeighborGroup(
      "NeighborGroup",
      {
        resourceGroup: group.resourceGroupName,
        ...props,
      },
    );
    return { group, res };
  });

const get = (resourceGroupName: string, neighborGroupName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetNeighborGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      neighborGroupName,
    });
  });

const CREATE: Props = {
  destination: { ipv4Addresses: ["10.10.10.10"] },
  tags: { env: "a" },
};

const UPDATE: Props = {
  destination: { ipv4Addresses: ["10.10.10.10", "10.10.10.11"] },
  annotation: "updated",
  tags: { env: "b" },
};

// ARM configuration object only (no fabric attached): $0, ~1-3 minutes.
test.provider(
  "create, update, replace, and delete a neighbor group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program(CREATE));
      const observed = yield* get(
        group.resourceGroupName,
        res.neighborGroupName,
      );
      expect(observed.properties.destination.ipv4Addresses).toEqual([
        "10.10.10.10",
      ]);
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("NeighborGroup");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program(UPDATE));
      expect(updated.res.neighborGroupId).toEqual(res.neighborGroupId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.neighborGroupName,
      );
      expect(reobserved.properties.destination.ipv4Addresses).toEqual([
        "10.10.10.10",
        "10.10.10.11",
      ]);
      expect(reobserved.properties.annotation).toEqual("updated");
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement.
      const replaced = yield* stack.deploy(
        program({ ...UPDATE, location: "westus3" }),
      );
      expect(replaced.res.neighborGroupId).not.toEqual(res.neighborGroupId);
      expect(replaced.res.location).toEqual("westus3");
      expect(
        yield* waitGone(get(group.resourceGroupName, res.neighborGroupName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.neighborGroupName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
