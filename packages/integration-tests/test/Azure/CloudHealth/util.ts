import * as Azure from "@alchemy.run/azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:cloudhealth", "live"];

export const subscriptionId = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Repeat a GET until it reports a typed not-found; `"gone"` or `"found"`. */
export const gone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );

/** Where a health model lives, for out-of-band reads. */
export const modelWhere = (resourceGroupName: string, healthModelName: string) =>
  Effect.map(subscriptionId, (subscriptionId) => ({
    subscriptionId,
    resourceGroupName,
    healthModelName,
  }));

export const getHealthModel = (resourceGroupName: string, healthModelName: string) =>
  Effect.flatMap(modelWhere(resourceGroupName, healthModelName), cloudhealth.GetHealthModel);

/** Resource group + health model with a system-assigned identity, shared by the child tests. */
export const modelProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const model = yield* Azure.CloudHealth.HealthModel("Model", {
    resourceGroup: group.resourceGroupName,
    location: "centralus",
    identity: { type: "SystemAssigned" },
  });
  return { group, model };
});
