import * as Azure from "@/Azure";
import * as cs from "@distilled.cloud/azure/containerservice";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:containerservice",
  "live",
] as const;

/**
 * The smallest test cluster: one Standard_D2s_v7 node (2 vCPUs, ~$0.10/h)
 * on the Free tier. ~6 min to create and ~5 min to delete. Each child test
 * uses its own region so suites can run side by side within the 4-vCPU
 * regional quota.
 */
export const testCluster = (
  location: string,
  props: Partial<Azure.ContainerService.ManagedClusterProps> = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const cluster = yield* Azure.ContainerService.ManagedCluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      location,
      defaultNodePool: { vmSize: "Standard_D2s_v7", count: 1 },
      ...props,
    });
    return { group, cluster };
  });

/** Poll a GET until it reports a typed not-found. */
export const untilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchIf(
      (e) =>
        e._tag === "ResourceNotFound" ||
        e._tag === "ResourceGroupNotFound" ||
        e._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 18,
    }),
  );

export const getCluster = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetManagedCluster({
      subscriptionId,
      resourceGroupName,
      resourceName,
    });
  });
