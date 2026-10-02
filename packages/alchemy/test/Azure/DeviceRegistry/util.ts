import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:deviceregistry",
  "live",
];

/** Device Registry regions; eastus is supported for every type. */
export const location = "eastus";

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
      times: 48,
    }),
  );

/** Arc custom location with Azure IoT Operations installed (paid-only tests). */
export const customLocationId = () =>
  process.env.AZURE_TEST_AIO_CUSTOM_LOCATION ?? "";

/** ARM ID of a custom location that does not exist (probes). */
export const missingCustomLocation = (
  subscriptionId: string,
  resourceGroupName: string,
) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ExtendedLocation/customLocations/missing`;
