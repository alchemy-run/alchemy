import { expect } from "@alchemy.run/test";
import * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT AI Model Experiments suites.
 *
 * An instance is a long-lived MLflow server. Price list v1.0.44 has no SKU for it and no public
 * price was found, so assume it is billed per started hour at an unknown rate, and gate every suite
 * that creates one behind the provider-wide slow flag `STACKIT_TEST_SLOW`. A full run creates four
 * instances: two in the instance suite, one each in the token and bindings suites. So at least four
 * instance-hours, at a rate nobody here can state.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/** The Go SDK allows 45 minutes for an instance to come up, and as long for it to go. */
export const INSTANCE_TEST_TIMEOUT = 5_400_000;

/** The instance, or `"gone"` on the typed not-found or once it is deleting. */
export const observeInstance = (projectId: string, region: string, instanceId: string) =>
  modelExperiments.getInstance({ projectId, regionId: region, instanceId }).pipe(
    Effect.map(({ instance }) => (instance.state === "deleting" ? ("gone" as const) : instance)),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** The token, or `"gone"` on the typed not-found or once it is deleting. */
export const observeToken = (
  projectId: string,
  region: string,
  instanceId: string,
  tokenId: string,
) =>
  modelExperiments.getInstanceToken({ projectId, regionId: region, instanceId, tokenId }).pipe(
    Effect.map(({ token }) => (token.state === "deleting" ? ("gone" as const) : token)),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** Bounded wait (about 2 minutes) until a read reports `"gone"`, then assert it. */
export const expectGone = <A, E, R>(read: Effect.Effect<A | "gone", E, R>) =>
  read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (value) => value === "gone",
      times: 24,
    }),
    Effect.tap((value) => Effect.sync(() => expect(value).toEqual("gone"))),
  );
