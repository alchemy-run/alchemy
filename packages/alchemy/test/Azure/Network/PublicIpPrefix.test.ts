import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPrefix = (resourceGroupName: string, publicIpPrefixName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetPublicIPPrefix({
      subscriptionId,
      resourceGroupName,
      publicIpPrefixName,
    }),
  );

// IPv4 prefixes bill per address (~$0.006/hour each): a /31 then a /30
// for a few minutes costs well under a cent.
const program = (props: {
  prefixLength: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "westus3",
    });
    const prefix = yield* Azure.Network.PublicIpPrefix("Egress", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
      publicIpAddressVersion: "IPv4",
      prefixLength: props.prefixLength,
      tags: props.tags,
    });
    return { group, prefix };
  });

test.provider(
  "create, update tags, replace, and delete a public IP prefix",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, prefix } = yield* stack.deploy(
        program({ prefixLength: 31, tags: { env: "test" } }),
      );
      expect(prefix.prefixLength).toEqual(31);
      expect(prefix.publicIpAddressVersion).toEqual("IPv4");
      expect(prefix.ipPrefix).toMatch(/\/31$/);
      const observed = yield* getPrefix(
        group.resourceGroupName,
        prefix.publicIpPrefixName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ prefixLength: 31, tags: { env: "prod" } }),
      );
      expect(updated.prefix.publicIpPrefixId).toEqual(prefix.publicIpPrefixId);
      expect(
        (yield* getPrefix(group.resourceGroupName, prefix.publicIpPrefixName))
          .tags?.env,
      ).toEqual("prod");

      // prefixLength is immutable: a /30 replaces the /31.
      const replaced = yield* stack.deploy(
        program({ prefixLength: 30, tags: { env: "prod" } }),
      );
      expect(replaced.prefix.publicIpPrefixId).not.toEqual(
        prefix.publicIpPrefixId,
      );
      expect(replaced.prefix.ipPrefix).toMatch(/\/30$/);
      expect(
        yield* untilGone(
          getPrefix(group.resourceGroupName, prefix.publicIpPrefixName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPrefix(
            group.resourceGroupName,
            replaced.prefix.publicIpPrefixName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
