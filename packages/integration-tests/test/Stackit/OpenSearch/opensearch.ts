import { expect } from "@alchemy.run/test";
import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT OpenSearch suites.
 *
 * Instances are billed per started hour by plan (about EUR 0.10 for the cheapest single-node plan), so every suite that creates
 * one is gated behind the provider-wide slow flag `STACKIT_TEST_SLOW`. A full run
 * creates five instances: three in the instance suite, one each in the credential and
 * bindings suites.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

export const VERSION = "2";
export const PLAN = "stackit-opensearch-1.4.10-single";

/** Reserved documentation range: nothing can connect, which these suites don't need. */
export const CLOSED_ACL = "192.0.2.1/32";

/** The instance, or `"gone"` on the typed not-found and gone errors. */
export const observeInstance = (projectId: string, region: string, instanceId: string) =>
  opensearch.getInstance({ projectId, regionId: region, instanceId }).pipe(
    Effect.map((instance) =>
      instance.instanceStatus === "deleted" ? ("gone" as const) : instance,
    ),
    Effect.catchTag(["NotFound", "InstanceGone"], () => Effect.succeed("gone" as const)),
  );

/** The credential, or `"gone"` on the typed not-found and gone errors. */
export const observeCredential = (
  projectId: string,
  region: string,
  instanceId: string,
  credentialsId: string,
) =>
  opensearch
    .getCredentials({ projectId, regionId: region, instanceId, credentialsId })
    .pipe(Effect.catchTag(["NotFound", "CredentialsGone"], () => Effect.succeed("gone" as const)));

/** Bounded check that an observation reports `"gone"`. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 24,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );
