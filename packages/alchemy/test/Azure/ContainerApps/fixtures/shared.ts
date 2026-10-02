import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

/** Public quickstart image serving HTTP 200 on port 80. */
export const QUICKSTART_IMAGE = "mcr.microsoft.com/k8se/quickstart:latest";

/** Public quickstart image for jobs: prints and exits 0. */
export const QUICKSTART_JOB_IMAGE =
  "mcr.microsoft.com/k8se/quickstart-jobs:latest";

/**
 * Free-trial subscriptions allow ONE standard (non-Express) Container Apps
 * environment in the whole subscription; a second create fails with
 * `MaxNumberOfGlobalEnvironmentsInSubExceeded`, and a failed environment
 * takes 10+ minutes to delete. Tests that create a standard environment hold
 * this permit for their whole body. `eastus` has no managed-cluster capacity
 * on the trial (`ManagedEnvironmentProvisioningError`); `westus2` works.
 */
const standardEnvironments = Semaphore.makeUnsafe(1);

/** Run a test body while holding the subscription's standard environment. */
export const withStandardEnvironment = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => standardEnvironments.withPermits(1)(self);

/** Region for standard environments. */
export const STANDARD_LOCATION = "westus2";

/** A Consumption workload profile (no reserved vCPUs). */
export const CONSUMPTION_PROFILES = [
  { name: "Consumption", workloadProfileType: "Consumption" },
];

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/** Poll an out-of-band GET until Azure reports the resource missing. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );
