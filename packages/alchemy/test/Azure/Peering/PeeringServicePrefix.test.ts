import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as peering from "@distilled.cloud/azure/peering";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  logLevel,
  serviceProvider,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * A prefix needs a prefix key that a Peering Service partner issued for a
 * prefix it announces for you. Set `AZURE_TEST_PEERING_PREFIX` and
 * `AZURE_TEST_PEERING_PREFIX_KEY` (with `AZURE_TEST_PAID=1`).
 */
const providerPrefix = {
  prefix: process.env.AZURE_TEST_PEERING_PREFIX ?? "",
  key: process.env.AZURE_TEST_PEERING_PREFIX_KEY ?? "",
};

const serviceProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const service = yield* Azure.Peering.PeeringService("Service", {
    resourceGroup: group.resourceGroupName,
    ...serviceProvider,
  });
  return { group, service };
});

const getPrefix = (
  resourceGroupName: string,
  peeringServiceName: string,
  prefixName: string,
) =>
  Effect.gen(function* () {
    return yield* peering.GetPrefix({
      subscriptionId: yield* subscription,
      resourceGroupName,
      peeringServiceName,
      prefixName,
    });
  });

// Free, but needs a prefix key issued by the Peering Service partner.
test.provider.skipIf(!runPaidOnly || !providerPrefix.key)(
  "create and delete a peering service prefix",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, prefix } = yield* stack.deploy(
        Effect.gen(function* () {
          const { group, service } = yield* serviceProgram;
          const prefix = yield* Azure.Peering.PeeringServicePrefix("Prefix", {
            resourceGroup: group.resourceGroupName,
            peeringService: service.peeringServiceName,
            prefix: providerPrefix.prefix,
            peeringServicePrefixKey: providerPrefix.key,
          });
          return { group, service, prefix };
        }),
      );
      const observed = yield* getPrefix(
        group.resourceGroupName,
        service.peeringServiceName,
        prefix.prefixName,
      );
      expect(observed.properties?.prefix).toEqual(providerPrefix.prefix);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getPrefix(
            group.resourceGroupName,
            service.peeringServiceName,
            prefix.prefixName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe: a free peering service rejects prefixes the partner has
// not provisioned with typed errors.
test.provider(
  "a prefix without a valid provider key is rejected with typed errors",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(serviceProgram);
      const request = {
        subscriptionId: yield* subscription,
        resourceGroupName: group.resourceGroupName,
        peeringServiceName: service.peeringServiceName,
        prefixName: "probe",
      };
      const noKey = yield* peering
        .PrefixesCreateOrUpdate({
          ...request,
          properties: { prefix: "192.0.2.0/24" },
        })
        .pipe(Effect.flip);
      expect(noKey._tag).toEqual("PeeringServicePrefixKeyInvalid");
      const unknownKey = yield* peering
        .PrefixesCreateOrUpdate({
          ...request,
          properties: {
            prefix: "192.0.2.0/24",
            peeringServicePrefixKey: "00000000-0000-0000-0000-000000000000",
          },
        })
        .pipe(Effect.flip);
      expect(unknownKey._tag).toEqual("PeeringServicePrefixValidationFailed");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
