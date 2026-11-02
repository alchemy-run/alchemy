import type * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT MongoDB Flex suites.
 *
 * Instances are billed per started hour (EUR 0.343 for the cheapest SKU,
 * `MongoDB-Flex-1.2-Replica-EU01`, plus storage), so every suite that creates one is
 * gated behind the provider-wide slow flag `STACKIT_TEST_SLOW`. A full run holds seven
 * instances for one or two started hours each: about EUR 2.40-4.80, plus storage.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/** The flavor of the cheapest SKU on the price list. */
export const FLAVOR = "1.2";
export const VERSION = "7.0";
export const REPLICAS = 3;

/** The class STACKIT's Terraform acceptance test deploys. */
export const STORAGE_CLASS = "premium-perf2-mongodb";

/** Reserved documentation range: nothing can connect, which these suites don't need. */
export const CLOSED_ACL = "192.0.2.1/32";

export const instanceProps = (acl: string = CLOSED_ACL) =>
  ({
    flavorId: FLAVOR,
    version: VERSION,
    replicas: REPLICAS,
    type: "Replica",
    storage: { class: STORAGE_CLASS, size: 10 },
    acl: [acl],
    backupSchedule: "0 2 * * *",
  }) satisfies Stackit.MongoDBFlex.InstanceProps;

/** The instance, or `"gone"` on the typed `NotFound`. */
export const observeInstance = (projectId: string, region: string, instanceId: string) =>
  mongodb.getInstance({ projectId, region, instanceId }).pipe(
    Effect.map((response) => response.item ?? ("gone" as const)),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** The user, or `"gone"` on the typed `NotFound`. */
export const observeUser = (
  projectId: string,
  region: string,
  instanceId: string,
  userId: string,
) =>
  mongodb.getUser({ projectId, region, instanceId, userId }).pipe(
    Effect.map((response) => response.item ?? ("gone" as const)),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

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
