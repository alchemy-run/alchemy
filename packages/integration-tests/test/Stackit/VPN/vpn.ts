import { expect } from "@alchemy.run/test";
import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT VPN suites.
 *
 * Every suite needs a live gateway, billed per started hour (price list v1.0.44, EU01:
 * `VPN-IPSec-100-HA` EUR 0.0879/h), so each one is gated behind the provider-wide slow flag
 * `STACKIT_TEST_SLOW`. They also need a project in a Network Area.
 *
 * A full run creates 12 gateways on the smallest plan, each billed at least one hour: 6 in
 * `Gateway.test.ts`, 3 in `Connection.test.ts`, and 1 each in `BGPFilter.test.ts`,
 * `BGPFilterRule.test.ts` and `Bindings.test.ts`. That is about EUR 1.05, and about EUR 2.10
 * if each one crosses into a second started hour, which a slow provisioning can do.
 *
 * STACKIT's default quota is 6 gateways per project. Each file runs its tests in sequence, and
 * the tests holding two gateways at once share {@link GATEWAY_QUOTA}, so a run stays within it.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/** Label for tests that hold two gateways at once. */
export const GATEWAY_QUOTA = "stackit:vpn-gateway-quota";

/** The official client waits up to 45 minutes for a gateway. */
export const SUITE_TIMEOUT = 3_000_000;

/** The smallest plan. */
export const PLAN = "p100";

/** Throwaway keys of no tunnel that ever comes up. */
export const PRE_SHARED_KEY = Redacted.make("alchemy-test-preshared-key-one");
export const ROTATED_KEY = Redacted.make("alchemy-test-preshared-key-two");

/** The first two zones of a region. */
export const zones = (region: string) => ({ tunnel1: `${region}-1`, tunnel2: `${region}-2` });

export const phase = {
  encryptionAlgorithms: ["aes256" as const],
  integrityAlgorithms: ["sha2_384" as const],
  dhGroups: ["ecp384" as const],
};

/** A tunnel to a documentation address: it never comes up, which no suite waits for. */
export const tunnel = (
  remoteAddress: string,
  preSharedKey: Redacted.Redacted<string> = PRE_SHARED_KEY,
) => ({ remoteAddress, preSharedKey, phase1: phase, phase2: phase });

export interface GatewayPlace {
  readonly projectId: string;
  readonly region: string;
}

/** Out-of-band: the gateway as STACKIT reports it, or `"gone"`. */
export const observeGateway = (place: GatewayPlace, gatewayId: string) =>
  vpn
    .getGateway({ ...place, gatewayId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** The provider already waits for the delete; this absorbs read lag only. */
export const expectGatewayGone = (place: GatewayPlace, gatewayId: string) =>
  observeGateway(place, gatewayId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (gateway) => gateway === "gone",
      times: 12,
    }),
    Effect.map((gateway) => expect(gateway).toEqual("gone")),
  );

/** Out-of-band: wait for a gateway this suite made directly to come up. */
export const untilGatewayReady = (place: GatewayPlace, gatewayId: string) =>
  vpn.getGateway({ ...place, gatewayId }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("15 seconds"),
      until: (gateway) => gateway.state === "READY",
      times: 180,
    }),
  );

/** Out-of-band: delete a gateway this suite made directly, and wait until it is gone. */
export const removeGateway = (place: GatewayPlace, gatewayId: string) =>
  vpn.deleteGateway({ ...place, gatewayId }).pipe(
    Effect.andThen(
      observeGateway(place, gatewayId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("15 seconds"),
          until: (gateway) => gateway === "gone",
          times: 80,
        }),
      ),
    ),
    Effect.ignore,
  );
