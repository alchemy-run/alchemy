import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:datadog", "live"];

/** Datadog monitors are only offered in a few regions. */
export const location = "westus2";

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Owner of the test Datadog organization (any reachable mailbox works). */
export const userInfo = {
  name: "Alchemy Test",
  emailAddress:
    process.env.AZURE_TEST_DATADOG_EMAIL ?? "alchemy-test@example.com",
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
  const monitor = yield* Azure.Datadog.Monitor("Monitor", {
    resourceGroup: group.resourceGroupName,
    location,
    userInfo,
  });
  return { group, monitor };
});
