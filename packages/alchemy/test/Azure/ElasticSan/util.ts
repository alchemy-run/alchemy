import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export const tags = ["provider:azure", "provider:azure:elasticsan", "live"];

/** Elastic SAN is available in a subset of regions; eastus supports it. */
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
      times: 24,
    }),
  );
