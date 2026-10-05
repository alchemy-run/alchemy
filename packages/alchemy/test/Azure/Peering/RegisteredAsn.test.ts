import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as peering from "@distilled.cloud/azure/peering";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, operator, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (asn: number) =>
  Effect.gen(function* () {
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
    const customer = yield* Azure.Peering.RegisteredAsn("Customer", {
      resourceGroup: group.resourceGroupName,
      peering: exchange.peeringName,
      asn,
    });
    return { group, exchange, customer };
  });

const getRegisteredAsn = (
  resourceGroupName: string,
  peeringName: string,
  registeredAsnName: string,
) =>
  Effect.gen(function* () {
    return yield* peering.GetRegisteredAsn({
      subscriptionId: yield* subscription,
      resourceGroupName,
      peeringName,
      registeredAsnName,
    });
  });

// Needs a provisioned peering of an approved Peering Service provider
// (`AZURE_TEST_PEER_ASN_ID`, see util.ts).
test.provider.skipIf(!runPaidOnly || !operator.peerAsnId)(
  "create, replace, and delete a registered ASN",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program(65010));
      const observed = yield* getRegisteredAsn(
        first.group.resourceGroupName,
        first.exchange.peeringName,
        first.customer.registeredAsnName,
      );
      expect(observed.properties?.asn).toEqual(65010);

      // The ASN is immutable: changing it replaces the registration.
      const second = yield* stack.deploy(program(65011));
      expect(second.customer.registeredAsnName).not.toEqual(
        first.customer.registeredAsnName,
      );
      expect(second.customer.asn).toEqual(65011);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegisteredAsn(
            second.group.resourceGroupName,
            second.exchange.peeringName,
            second.customer.registeredAsnName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: without an approved peer ASN there is no peering, so a registered ASN has
// no parent and Azure reports the typed not-found.
test.provider(
  "a registered ASN without a peering is rejected with a typed error",
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
        .RegisteredAsnsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          peeringName: "alchemy-peering-probe-missing",
          registeredAsnName: "probe",
          properties: { asn: 65010 },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
