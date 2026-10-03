import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as peering from "@distilled.cloud/azure/peering";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * Registering an ASN starts a manual validation by Microsoft's peering
 * team, so only an operator may register its own ASN. Set
 * `AZURE_TEST_PEER_ASN` (with `AZURE_TEST_PAID=1`).
 */
const asn = Number(process.env.AZURE_TEST_PEER_ASN ?? "0");

const program = (peerName: string) =>
  Effect.gen(function* () {
    const registration = yield* Azure.Peering.PeerAsn("Asn", {
      peerAsn: asn,
      peerName,
      peerContactDetail: [
        { role: "Noc", email: "noc@example.com", phone: "+1 555 0100" },
      ],
    });
    return { registration };
  });

const getPeerAsn = (peerAsnName: string) =>
  Effect.gen(function* () {
    return yield* peering.GetPeerAsn({
      subscriptionId: yield* subscription,
      peerAsnName,
    });
  });

// Free, but requires an ASN the operator owns (manual Microsoft review).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a peer ASN registration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("Alchemy Test"));
      const observed = yield* getPeerAsn(first.registration.peerAsnName);
      expect(observed.properties?.peerAsn).toEqual(asn);
      expect(observed.properties?.peerName).toEqual("Alchemy Test");

      const second = yield* stack.deploy(program("Alchemy Test Renamed"));
      expect(second.registration.peerAsnId).toEqual(
        first.registration.peerAsnId,
      );
      const updated = yield* getPeerAsn(second.registration.peerAsnName);
      expect(updated.properties?.peerName).toEqual("Alchemy Test Renamed");

      yield* stack.destroy();
      expect(
        yield* waitGone(getPeerAsn(second.registration.peerAsnName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe: a missing registration reads back as the typed `NotFound`
// the provider treats as absent.
test.provider(
  "a missing peer ASN reads back as a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* getPeerAsn("alchemy-peering-probe-missing").pipe(
        Effect.flip,
      );
      expect(error._tag).toEqual("NotFound");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);
