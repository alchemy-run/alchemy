import * as Stackit from "@alchemy.run/stackit";
import { smallPool } from "../pool.ts";

/**
 * Where the suite's `main` workloads push their images: a registry the deploying
 * machine is logged in to and the nodes can pull from anonymously. Unset, only the
 * pre-built `image` workload runs.
 */
export const REGISTRY = process.env.STACKIT_TEST_REGISTRY;

/** The cluster the adapter suite's workloads run on. */
export const AdapterCluster = Stackit.SKE.Cluster("SkeAdapterCluster", {
  nodepools: [smallPool],
  ...(REGISTRY === undefined ? {} : { registry: { server: REGISTRY } }),
});

/** The zone the effectful workload reads through a binding. */
export const AdapterZone = Stackit.DNS.Zone("SkeAdapterZone", {});
