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

// The free trial rejects every IPv4 prefix (even a /31) with the regional
// public IP quota, so the lifecycle uses IPv6 prefixes, which bill
// ~$0.006/hour per prefix; the test runs for a few minutes.
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
      publicIpAddressVersion: "IPv6",
      prefixLength: props.prefixLength,
      tags: props.tags,
    });
    return { group, prefix };
  });

test.provider(
  "create, update tags, and delete a public IP prefix",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, prefix } = yield* stack.deploy(
        program({ prefixLength: 127, tags: { env: "test" } }),
      );
      expect(prefix.prefixLength).toEqual(127);
      expect(prefix.publicIpAddressVersion).toEqual("IPv6");
      expect(prefix.ipPrefix).toMatch(/\/127$/);
      const observed = yield* getPrefix(
        group.resourceGroupName,
        prefix.publicIpPrefixName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ prefixLength: 127, tags: { env: "prod" } }),
      );
      expect(updated.prefix.publicIpPrefixId).toEqual(prefix.publicIpPrefixId);
      expect(
        (yield* getPrefix(group.resourceGroupName, prefix.publicIpPrefixName))
          .tags?.env,
      ).toEqual("prod");

      // No replacement step: the trial's quota of 3 IPv6 addresses per
      // region cannot hold the old and new /127 prefixes at once.

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPrefix(group.resourceGroupName, prefix.publicIpPrefixName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

test.provider(
  "an IPv4 prefix is rejected with the typed public IP quota error on the trial",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("ProbeGroup", {
            location: "westus3",
          });
          return { group };
        }),
      );
      const sub = yield* subscriptionId;
      const error = yield* network
        .PublicIPPrefixesCreateOrUpdate({
          subscriptionId: sub,
          resourceGroupName: group.resourceGroupName,
          publicIpPrefixName: "ipv4-probe",
          location: "westus3",
          sku: { name: "Standard", tier: "Regional" },
          properties: { prefixLength: 30, publicIPAddressVersion: "IPv4" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("QuotaExceeded");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
