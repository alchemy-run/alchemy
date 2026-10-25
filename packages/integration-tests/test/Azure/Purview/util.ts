import * as Azure from "@alchemy.run/azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as purview from "@distilled.cloud/azure/purview";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:purview", "live"];

/** The tenant's home region; a tenant's first Purview account must be here. */
export const location = "eastus";

export const subscriptionId = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

export const getAccount = (resourceGroupName: string, accountName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    purview.GetAccount({ subscriptionId, resourceGroupName, accountName }),
  );

export const getKafkaConfiguration = (
  resourceGroupName: string,
  accountName: string,
  kafkaConfigurationName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    purview.GetKafkaConfiguration({
      subscriptionId,
      resourceGroupName,
      accountName,
      kafkaConfigurationName,
    }),
  );

/**
 * Repeat a GET until it reports a typed not-found, or `isGone` holds (a
 * soft-deleted account); `"gone"` or `"found"`. Purview deletes take
 * minutes.
 */
export const gone = <A, R>(
  get: Effect.Effect<A, AzureOpError, R>,
  isGone: (value: A) => boolean = () => false,
) =>
  get.pipe(
    Effect.map((value) => (isGone(value) ? ("gone" as const) : ("found" as const))),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("15 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

/** A soft-deleted account no longer counts as present. */
export const softDeleted = (account: purview.GetAccountResponse) =>
  account.properties?.provisioningState === "SoftDeleted";
