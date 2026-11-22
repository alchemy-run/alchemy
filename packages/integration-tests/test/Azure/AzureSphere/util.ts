import * as Azure from "@alchemy.run/azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as sphere from "@distilled.cloud/azure/sphere";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:azuresphere", "live"];

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
      times: 24,
    }),
  );

export const getCatalog = (resourceGroupName: string, catalogName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    sphere.GetCatalog({ subscriptionId, resourceGroupName, catalogName }),
  );

export const getProduct = (resourceGroupName: string, catalogName: string, productName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    sphere.GetProduct({ subscriptionId, resourceGroupName, catalogName, productName }),
  );

export const getDeviceGroup = (
  resourceGroupName: string,
  catalogName: string,
  productName: string,
  deviceGroupName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    sphere.GetDeviceGroup({
      subscriptionId,
      resourceGroupName,
      catalogName,
      productName,
      deviceGroupName,
    }),
  );

/** Resource group + catalog shared by the child-resource tests. */
export const catalogProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const catalog = yield* Azure.AzureSphere.Catalog("Catalog", {
    resourceGroup: group.resourceGroupName,
  });
  return { group, catalog };
});
