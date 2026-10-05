import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  subscriptionId,
  tags,
  untilGone,
  withNetworkManager,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPool = (
  resourceGroupName: string,
  networkManagerName: string,
  poolName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetIpamPool({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      poolName,
    }),
  );
const getCidr = (
  resourceGroupName: string,
  networkManagerName: string,
  poolName: string,
  staticCidrName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetStaticCidr({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      poolName,
      staticCidrName,
    }),
  );

// IPAM pools and reservations are free.
const program = (props: { description: string; cidr: string; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const manager = yield* Azure.Network.NetworkManager("Manager", {
      resourceGroup: group.resourceGroupName,
      scopeAccesses: [],
    });
    const pool = yield* Azure.Network.IpamPool("Root", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      description: props.description,
      addressPrefixes: ["10.0.0.0/16"],
      tags: { env: props.env },
    });
    const cidr = yield* Azure.Network.IpamPoolStaticCidr("OnPrem", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      ipamPool: pool.ipamPoolName,
      description: props.description,
      addressPrefixes: [props.cidr],
    });
    return { group, manager, pool, cidr };
  });

test.provider(
  "create, update, and delete an IPAM pool (with a static CIDR)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager, pool, cidr } = yield* stack.deploy(
        program({ description: "one", cidr: "10.0.5.0/24", env: "test" }),
      );
      expect(pool.addressPrefixes).toEqual(["10.0.0.0/16"]);
      expect(cidr.addressPrefixes).toEqual(["10.0.5.0/24"]);
      const observedPool = yield* getPool(
        group.resourceGroupName,
        manager.networkManagerName,
        pool.ipamPoolName,
      );
      expect(observedPool.properties.description).toEqual("one");
      expect(observedPool.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ description: "two", cidr: "10.0.6.0/24", env: "prod" }),
      );
      expect(updated.pool.ipamPoolId).toEqual(pool.ipamPoolId);
      const reobservedPool = yield* getPool(
        group.resourceGroupName,
        manager.networkManagerName,
        pool.ipamPoolName,
      );
      expect(reobservedPool.properties.description).toEqual("two");
      expect(reobservedPool.tags?.env).toEqual("prod");
      // The reserved prefix is immutable: the CIDR is replaced.
      expect(updated.cidr.addressPrefixes).toEqual(["10.0.6.0/24"]);
      const observedCidr = yield* getCidr(
        group.resourceGroupName,
        manager.networkManagerName,
        pool.ipamPoolName,
        updated.cidr.staticCidrName,
      );
      expect(observedCidr.properties?.description).toEqual("two");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPool(
            group.resourceGroupName,
            manager.networkManagerName,
            pool.ipamPoolName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withNetworkManager, logLevel),
  { tags, timeout: 600_000 },
);
