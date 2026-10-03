import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:kubernetesconfiguration",
  "live",
] as const;

/**
 * A small AKS cluster that can host extensions: one Standard_D4s_v7 node
 * (4 vCPUs, ~$0.20/h; a 2-vCPU node leaves too little room for the
 * extension agents and the Flux controllers) on the Free tier. ~4-6 min to
 * create and ~5 min to delete.
 */
export const testCluster = (location: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const cluster = yield* Azure.ContainerService.ManagedCluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      location,
      defaultNodePool: { vmSize: "Standard_D4s_v7", count: 1 },
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
