import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:automation", "live"];

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

/**
 * The free-trial subscription allows ONE Automation account per region
 * (only eastus, eastus2, westus, northeurope, southeastasia, japanwest), and
 * a deleted account keeps counting for 30 days unless it is recovered. So
 * every test deploys the same account — fixed resource group and name in
 * eastus2 — which the provider recovers from soft-delete on each run, and
 * the test files take turns with it.
 */
export const SHARED = {
  resourceGroup: "alchemy-test-automation-probe",
  account: "alchemy-probe-a1",
  location: "eastus2",
} as const;

/**
 * Second account slot (westus) used only by the account replacement test.
 */
export const REPLACEMENT = {
  account: "alchemy-test-automation-replaced",
  location: "westus",
} as const;

const sharedAccount = Semaphore.makeUnsafe(1);

/** Run a test body while holding the one shared Automation account. */
export const withSharedAccount = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => sharedAccount.withPermits(1)(self);

/** Resource group + the shared Automation account every child test deploys. */
export const account = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    name: SHARED.resourceGroup,
    location: SHARED.location,
  });
  const account = yield* Azure.Automation.AutomationAccount("Account", {
    resourceGroup: group.resourceGroupName,
    name: SHARED.account,
    location: SHARED.location,
  });
  return {
    group,
    account,
    where: {
      resourceGroup: group.resourceGroupName,
      automationAccount: account.automationAccountName,
    },
  };
});
