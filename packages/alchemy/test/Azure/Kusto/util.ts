import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:kusto", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(
  get: Effect.Effect<A, AzureOpError, R>,
  times = 24,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times,
    }),
  );

/**
 * Resource group + the cheapest Dev cluster (`Dev(No SLA)_Standard_E2a_v4`,
 * ~$0.25/hour, 10-20 minutes to create, 5-10 minutes to delete).
 */
export const devCluster = (
  props: {
    sku?: Azure.Kusto.KustoClusterSku;
    languageExtensions?: Azure.Kusto.KustoLanguageExtension[];
  } = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cluster = yield* Azure.Kusto.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      sku: props.sku,
      languageExtensions: props.languageExtensions,
    });
    return { group, cluster };
  });
