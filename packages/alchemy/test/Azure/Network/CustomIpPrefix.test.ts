import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPrefix = (resourceGroupName: string, customIpPrefixName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetCustomIPPrefix({
      subscriptionId,
      resourceGroupName,
      customIpPrefixName,
    }),
  );

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const prefix = yield* Azure.Network.CustomIpPrefix("Prefix", {
      resourceGroup: group.resourceGroupName,
      cidr: process.env.AZURE_TEST_BYOIP_CIDR ?? "",
      authorizationMessage: process.env.AZURE_TEST_BYOIP_AUTH_MESSAGE,
      signedMessage: process.env.AZURE_TEST_BYOIP_SIGNED_MESSAGE,
      zones: ["1", "2", "3"],
      tags: props.tags,
    });
    return { group, prefix };
  });

// BYOIP needs a public range we own, a ROA authorizing ASN 8075, and a
// signed authorization message (AZURE_TEST_BYOIP_CIDR, ..._AUTH_MESSAGE,
// ..._SIGNED_MESSAGE). No ungated probe: Azure accepts any range and
// validates it asynchronously (the prefix sits in `Provisioning` for a long
// time and cannot be deleted until validation settles).
// Needs an owned public range (AZURE_TEST_BYOIP_CIDR, ..._AUTH_MESSAGE,
// ..._SIGNED_MESSAGE); provisioning takes ~30 minutes to hours. Free while
// provisioned (not commissioned). Run with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a custom IP prefix",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, prefix } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(prefix.commissionedState).toEqual("Provisioned");
      const observed = yield* getPrefix(
        group.resourceGroupName,
        prefix.customIpPrefixName,
      );
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.prefix.customIpPrefixId).toEqual(prefix.customIpPrefixId);
      const reobserved = yield* getPrefix(
        group.resourceGroupName,
        prefix.customIpPrefixName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPrefix(group.resourceGroupName, prefix.customIpPrefixName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
