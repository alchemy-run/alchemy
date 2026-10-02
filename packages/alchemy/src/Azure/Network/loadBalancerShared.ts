import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { NetworkPath } from "./generic.ts";

// Shared by load balancer children. Internal: not exported from index.ts.

/** Tags of the parent load balancer (ownership of its tagless children). */
export const loadBalancerTags = (subscriptionId: string, path: NetworkPath) =>
  orUndefinedIfNotFound(
    network.GetLoadBalancer({
      subscriptionId,
      resourceGroupName: path.resourceGroup,
      loadBalancerName: path.loadBalancer!,
    }),
  ).pipe(Effect.map((lb) => lb?.tags));
