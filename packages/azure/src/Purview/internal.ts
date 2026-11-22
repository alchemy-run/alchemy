import * as purview from "@distilled.cloud/azure/purview";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/*
 * Shared, un-exported helpers for the Purview resources. Not re-exported
 * from `index.ts`.
 */

export type ObservedAccount = purview.GetAccountResponse | purview.Account;

/**
 * Observe a Purview account; `undefined` when it does not exist. A
 * soft-deleted account (`provisioningState: "SoftDeleted"`) counts as gone:
 * it can no longer be used and a PUT with the same name recreates it.
 */
export const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    purview.GetAccount({ subscriptionId, resourceGroupName, accountName }),
  ).pipe(
    Effect.map((account) =>
      account?.properties?.provisioningState === "SoftDeleted" ? undefined : account,
    ),
  );

/**
 * Children of an account (Kafka configurations) carry no tags. They count
 * as owned when their parent account carries this stack's and stage's
 * ownership tags.
 */
export const accountOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) {
  const observed = yield* getAccount(subscriptionId, resourceGroupName, accountName);
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack && observed?.tags?.["alchemy::stage"] === stage
  );
});

/**
 * Globally unique account name (`<name>.purview.azure.com`): 3-63 letters,
 * digits, and hyphens, starting and ending with a letter or digit.
 */
export const createAccountName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({ id, maxLength: 63, lowercase: true }))
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return name.length >= 3 ? name : `pv-${name}`;
});

/**
 * Kafka configuration name: letters, digits, hyphens, and underscores,
 * starting and ending with a letter or digit.
 */
export const createKafkaConfigurationName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 63 });
  return name.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
});

export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();
