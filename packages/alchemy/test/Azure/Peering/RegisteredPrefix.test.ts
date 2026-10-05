import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as peering from "@distilled.cloud/azure/peering";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, operator, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** A customer prefix announced over the operator's peering. */
const customerPrefix = process.env.AZURE_TEST_PEERING_PREFIX ?? "";

const program = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const exchange = yield* Azure.Peering.Peering("Exchange", {
    resourceGroup: group.resourceGroupName,
    kind: "Exchange",
    sku: "Basic_Exchange_Free",
    peeringLocation: operator.peeringLocation,
    exchange: {
      peerAsnId: operator.peerAsnId,
      connections: [{ peeringDBFacilityId: operator.facilityId }],
    },
  });
  const prefix = yield* Azure.Peering.RegisteredPrefix("Prefix", {
    resourceGroup: group.resourceGroupName,
    peering: exchange.peeringName,
    prefix: customerPrefix,
  });
  return { group, exchange, prefix };
});

const getRegisteredPrefix = (
  resourceGroupName: string,
  peeringName: string,
  registeredPrefixName: string,
) =>
  Effect.gen(function* () {
    return yield* peering.GetRegisteredPrefix({
      subscriptionId: yield* subscription,
      resourceGroupName,
      peeringName,
      registeredPrefixName,
    });
  });

// Needs a provisioned peering of an approved Peering Service provider
// that announces `AZURE_TEST_PEERING_PREFIX`.
test.provider.skipIf(!runPaidOnly || !operator.peerAsnId || !customerPrefix)(
  "create and delete a registered prefix",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, exchange, prefix } = yield* stack.deploy(program);
      const observed = yield* getRegisteredPrefix(
        group.resourceGroupName,
        exchange.peeringName,
        prefix.registeredPrefixName,
      );
      expect(observed.properties?.prefix).toEqual(customerPrefix);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegisteredPrefix(
            group.resourceGroupName,
            exchange.peeringName,
            prefix.registeredPrefixName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: without an approved peer ASN there is no peering, so a registered prefix
// has no parent and Azure reports the typed not-found.
test.provider(
  "a registered prefix without a peering is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* peering
        .RegisteredPrefixesCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          peeringName: "alchemy-peering-probe-missing",
          registeredPrefixName: "probe",
          properties: { prefix: "192.0.2.0/24" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
