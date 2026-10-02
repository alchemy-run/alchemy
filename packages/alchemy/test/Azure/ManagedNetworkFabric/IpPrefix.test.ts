import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  location: string;
  rules: Azure.ManagedNetworkFabric.IpPrefixRule[];
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const prefix = yield* Azure.ManagedNetworkFabric.IpPrefix("Prefix", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      ipPrefixRules: props.rules,
      tags: props.tags,
    });
    return { group, prefix };
  });

const get = (resourceGroupName: string, ipPrefixName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetIpPrefix({
      subscriptionId: yield* subscription,
      resourceGroupName,
      ipPrefixName,
    });
  });

// ARM configuration object only (no fabric attached): $0, ~1-2 minutes.
test.provider(
  "create, update, replace, and delete an IP prefix list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = [
        { action: "Permit", sequenceNumber: 10, networkPrefix: "10.0.0.0/8" },
      ];
      const { group, prefix } = yield* stack.deploy(
        program({ location: "eastus", rules: first, tags: { env: "a" } }),
      );
      const observed = yield* get(group.resourceGroupName, prefix.ipPrefixName);
      expect(observed.properties.ipPrefixRules).toEqual(first);
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("Prefix");
      expect(prefix.provisioningState).toEqual("Succeeded");

      // In place: add a rule and change tags.
      const second = [
        ...first,
        {
          action: "Deny",
          sequenceNumber: 20,
          networkPrefix: "192.168.0.0/16",
        },
      ];
      const updated = yield* stack.deploy(
        program({ location: "eastus", rules: second, tags: { env: "b" } }),
      );
      expect(updated.prefix.ipPrefixId).toEqual(prefix.ipPrefixId);
      const reobserved = yield* get(
        group.resourceGroupName,
        prefix.ipPrefixName,
      );
      expect(reobserved.properties.ipPrefixRules).toEqual(second);
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement: location is immutable.
      const replaced = yield* stack.deploy(
        program({ location: "westus3", rules: second, tags: { env: "b" } }),
      );
      expect(replaced.prefix.location).toEqual("westus3");
      expect(replaced.prefix.ipPrefixId).not.toEqual(prefix.ipPrefixId);

      yield* stack.destroy();
      expect(
        yield* waitGone(get(group.resourceGroupName, prefix.ipPrefixName)),
      ).toEqual("gone");
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.prefix.ipPrefixName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
