import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as peering from "@distilled.cloud/azure/peering";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, operator, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { maxPrefixes: number; env: string }) =>
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
        connections: [
          {
            peeringDBFacilityId: operator.facilityId,
            bgpSession: { maxPrefixesAdvertisedV4: props.maxPrefixes },
          },
        ],
      },
      tags: { env: props.env },
    });
    return { group, exchange };
  });

const getPeering = (resourceGroupName: string, peeringName: string) =>
  Effect.gen(function* () {
    return yield* peering.GetPeering({
      subscriptionId: yield* subscription,
      resourceGroupName,
      peeringName,
    });
  });

// Free SKU, but needs an operator ASN that Microsoft approved and presence
// at the exchange (`AZURE_TEST_PEER_ASN_ID`, `AZURE_TEST_PEERING_FACILITY_ID`);
// provisioning is done by Microsoft and can take days.
test.provider.skipIf(!runPaidOnly || !operator.peerAsnId)(
  "create, update, and delete an exchange peering",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ maxPrefixes: 1000, env: "test" }),
      );
      const observed = yield* getPeering(
        first.group.resourceGroupName,
        first.exchange.peeringName,
      );
      expect(observed.kind).toEqual("Exchange");
      expect(observed.tags?.env).toEqual("test");

      const second = yield* stack.deploy(
        program({ maxPrefixes: 2000, env: "prod" }),
      );
      const updated = yield* getPeering(
        second.group.resourceGroupName,
        second.exchange.peeringName,
      );
      expect(updated.tags?.env).toEqual("prod");
      expect(
        updated.properties?.exchange?.connections?.[0]?.bgpSession
          ?.maxPrefixesAdvertisedV4,
      ).toEqual(2000);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getPeering(
            second.group.resourceGroupName,
            second.exchange.peeringName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: without an approved peer ASN, so Azure rejects any
// peering with the typed error.
test.provider(
  "a peering without an approved peer ASN is rejected with a typed error",
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
      const subscriptionId = yield* subscription;
      const error = yield* peering
        .PeeringsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          peeringName: "probe",
          location: "eastus",
          kind: "Exchange",
          sku: { name: "Basic_Exchange_Free" },
          properties: {
            peeringLocation: "Seattle",
            exchange: {
              peerAsn: {
                id: `/subscriptions/${subscriptionId}/providers/Microsoft.Peering/peerAsns/alchemy-peering-probe-missing`,
              },
              connections: [],
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("PeeringPeerAsnNotApproved");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
