import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:peering", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/**
 * A Peering Service partner that the free trial can create a peering
 * service against (from `ListPeeringServiceProviders`).
 */
export const serviceProvider = {
  peeringServiceLocation: "Washington",
  peeringServiceProvider: "T-Mobile USA",
  providerPrimaryPeeringLocation: "San Jose",
} as const;

/**
 * Peering lifecycles need an operator's ASN that Microsoft approved for
 * the subscription. Set `AZURE_TEST_PEER_ASN_ID` (ARM ID of the approved
 * peer ASN), `AZURE_TEST_PEERING_LOCATION` and
 * `AZURE_TEST_PEERING_FACILITY_ID` (PeeringDB facility of the exchange)
 * together with `AZURE_TEST_PAID=1`.
 */
export const operator = {
  peerAsnId: process.env.AZURE_TEST_PEER_ASN_ID ?? "",
  peeringLocation: process.env.AZURE_TEST_PEERING_LOCATION ?? "Seattle",
  facilityId: Number(process.env.AZURE_TEST_PEERING_FACILITY_ID ?? "0"),
};
