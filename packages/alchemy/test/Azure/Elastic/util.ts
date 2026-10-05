import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:elastic", "live"];

export const location = "westus2";

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/**
 * Owner of the test Elastic Cloud organization. Elastic fails deployment
 * creation (after ~45 minutes, with a generic 500) for reserved domains
 * such as example.com, so the default is a real domain.
 */
export const userInfo = {
  emailAddress:
    process.env.AZURE_TEST_ELASTIC_EMAIL ?? "alchemy-elastic@alchemy.run",
  firstName: "Alchemy",
  lastName: "Test",
  companyName: "Alchemy",
};

/** Poll an out-of-band GET until it reports a typed not-found. */
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
      times: 60,
    }),
  );

/** Group + monitor, the parents of every child test. */
export const monitorStack = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", { location });
  const monitor = yield* Azure.Elastic.Monitor("Monitor", {
    resourceGroup: group.resourceGroupName,
    location,
    userInfo,
  });
  return { group, monitor };
});
