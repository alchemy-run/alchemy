import type * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT Key Value Store suites.
 *
 * Instances are billed per started hour by plan (no price could be read; comparable single nodes run about EUR 0.10-0.12), so every suite that creates
 * one is gated behind the provider-wide slow flag `STACKIT_TEST_SLOW`. A full run holds
 * about six instances for an hour each.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/**
 * The version and smallest plan. No source lists them for certain: a wrong name fails
 * the first deploy with `DataServicePlanNotFound`, which lists the project's choices.
 */
export const VERSION = "x";
export const PLAN = "stackit-keyvalue-1.2.10-single";

/** Reserved documentation range: nothing can connect, which these suites don't need. */
export const CLOSED_ACL = "192.0.2.1/32";

export const instanceProps = (acl: string = CLOSED_ACL) =>
  ({
    version: VERSION,
    planName: PLAN,
    acl: [acl],
  }) satisfies Stackit.Valkey.InstanceProps;

/** The instance, or `"gone"` on the typed not-found and gone errors. */
export const observeInstance = (projectId: string, regionId: string, instanceId: string) =>
  valkey
    .getInstance({ projectId, regionId, instanceId })
    .pipe(Effect.catchTag(["NotFound", "InstanceGone"], () => Effect.succeed("gone" as const)));

/** The credential, or `"gone"` on the typed not-found and gone errors. */
export const observeCredential = (
  projectId: string,
  regionId: string,
  instanceId: string,
  credentialsId: string,
) =>
  valkey
    .getCredentials({ projectId, regionId, instanceId, credentialsId })
    .pipe(Effect.catchTag(["NotFound", "CredentialsGone"], () => Effect.succeed("gone" as const)));

/** Bounded check that an observation reports `"gone"`. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 12,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );
