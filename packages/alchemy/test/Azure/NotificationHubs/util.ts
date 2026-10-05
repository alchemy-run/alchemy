import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as notificationhubs from "@distilled.cloud/azure/notificationhubs";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:notificationhubs",
  "live",
];

export const subscriptionId = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Repeat a GET until it reports a typed not-found; `"gone"` or `"found"`. */
export const gone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );

export const getNamespace = (
  resourceGroupName: string,
  namespaceName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    notificationhubs.GetNamespace({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    }),
  );

export const getHub = (
  resourceGroupName: string,
  namespaceName: string,
  notificationHubName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    notificationhubs.GetNotificationHub({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      notificationHubName,
    }),
  );

/** Resource group + Free namespace shared by the child-resource tests. */
export const namespaceProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const ns = yield* Azure.NotificationHubs.Namespace("Push", {
    resourceGroup: group.resourceGroupName,
  });
  return { group, ns };
});
