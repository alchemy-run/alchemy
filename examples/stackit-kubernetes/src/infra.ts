import * as Stackit from "@alchemy.run/stackit";
import * as Config from "effect/Config";

/**
 * One node of the cheapest 2-vCPU machine. `IMAGE_REGISTRY` is where workloads with
 * a `main` push their images: a registry you are logged in to with `docker login`,
 * and that the nodes can pull from with no login, such as `ghcr.io/my-org`.
 *
 * Pass the `Config` as the prop: a deploy resolves it. Don't `yield*` it here,
 * because a workload's props run again in the deployed program, where the variable
 * isn't set, and the failed read would crash the pod.
 */
export const AppCluster = Stackit.SKE.Cluster("AppCluster", {
  nodepools: [
    {
      name: "workers",
      machineType: "c1.2",
      availabilityZones: ["eu01-1"],
      minimum: 1,
      maximum: 1,
      volumeSize: 20,
    },
  ],
  registry: { server: Config.String("IMAGE_REGISTRY") },
});

/** The zone the API reads through a binding. */
export const Domain = Stackit.DNS.Zone("Domain", {});
