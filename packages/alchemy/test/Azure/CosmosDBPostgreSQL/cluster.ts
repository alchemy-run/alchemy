import * as Azure from "@/Azure";
import * as postgresqlhsc from "@distilled.cloud/azure/postgresqlhsc";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

/** Region the trial accepts Cosmos DB for PostgreSQL clusters in. */
export const COSMOS_PG_TEST_LOCATION =
  process.env.AZURE_COSMOS_PG_LOCATION ?? "centralus";

export const tags = [
  "provider:azure",
  "provider:azure:cosmosdbpostgresql",
  "live",
];

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Resource group + the cheapest cluster (single node, Burstable 1 vCore,
 * 32 GiB: ≈ $0.05/h, 10-20 min to create) that child-resource tests
 * attach to.
 */
export const testCluster = (
  props: Partial<Azure.CosmosDBPostgreSQL.ClusterProps> = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_PG_TEST_LOCATION,
    });
    const cluster = yield* Azure.CosmosDBPostgreSQL.Cluster("Cluster", {
      ...props,
      resourceGroup: group.resourceGroupName,
      location: COSMOS_PG_TEST_LOCATION,
    });
    return { group, cluster };
  });

export const clusterRef = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return { subscriptionId, resourceGroupName, clusterName };
  });

/** Poll `get` until it fails with a typed not-found tag (bounded). */
export const untilGone = <A, R>(
  get: Effect.Effect<A, postgresqlhsc.GetClusterError, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("15 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

/**
 * Cosmos DB for PostgreSQL is retiring: Azure rejects every new cluster
 * (`CosmosPostgresProvisioningRetired`), so child-resource lifecycles can
 * only run against a cluster that predates the retirement. Set
 * `AZURE_COSMOS_PG_CLUSTER=<resourceGroup>/<clusterName>` to run them.
 */
const existing = process.env.AZURE_COSMOS_PG_CLUSTER?.split("/");
export const existingCluster =
  existing?.length === 2
    ? { resourceGroup: existing[0]!, cluster: existing[1]! }
    : undefined;
