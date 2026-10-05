import * as Azure from "@/Azure";
import * as mongocluster from "@distilled.cloud/azure/mongocluster";
import * as Effect from "effect/Effect";
import { subscriptionId } from "./helpers.ts";

export const mongoTags = ["provider:azure", "provider:azure:cosmosdb", "live"];

/** Region for mongo (vCore) cluster tests. */
export const MONGO_LOCATION = "centralus";

/**
 * Resource group + a cluster for child-resource tests. Child tests use the
 * cheapest paid tier (M10, a few cents per run) so they do not compete
 * with the cluster test for the subscription's single Free-tier cluster.
 */
export const testCluster = (
  props: Partial<Azure.CosmosDB.MongoClusterProps> = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: MONGO_LOCATION,
    });
    const cluster = yield* Azure.CosmosDB.MongoCluster("Cluster", {
      computeTier: "M10",
      ...props,
      resourceGroup: group.resourceGroupName,
      location: MONGO_LOCATION,
    });
    return { group, cluster };
  });

export const clusterRef = (
  resourceGroupName: string,
  mongoClusterName: string,
) =>
  Effect.map(subscriptionId, (subscriptionId) => ({
    subscriptionId,
    resourceGroupName,
    mongoClusterName,
  }));

export const getCluster = (
  resourceGroupName: string,
  mongoClusterName: string,
) =>
  Effect.flatMap(clusterRef(resourceGroupName, mongoClusterName), (ref) =>
    mongocluster.GetMongoCluster(ref),
  );
