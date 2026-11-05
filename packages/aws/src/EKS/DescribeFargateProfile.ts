import * as eks from "@distilled.cloud/aws/eks";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeFargateProfile`.
 *
 * Reads one Fargate profile's state — pod execution role, selectors, subnets, and status.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeFargateProfile` is granted on the cluster's sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeFargateProfileHttp)`.
 * ### Inspecting Compute
 * **Example:** Read a Fargate Profile
 * ```typescript
 * // init
 * const describeFargateProfile = yield* AWS.EKS.DescribeFargateProfile(cluster);
 *
 * // runtime
 * const { fargateProfile } = yield* describeFargateProfile({
 *   fargateProfileName: "default",
 * });
 * ```
 *
 * @binding
 */
export interface DescribeFargateProfile extends Binding.Service<
  DescribeFargateProfile,
  "AWS.EKS.DescribeFargateProfile",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.DescribeFargateProfileRequest, "clusterName">,
    ) => Effect.Effect<eks.DescribeFargateProfileResponse, eks.DescribeFargateProfileError>
  >
> {}
export const DescribeFargateProfile = Binding.Service<DescribeFargateProfile>(
  "AWS.EKS.DescribeFargateProfile",
);

export const DescribeFargateProfileHttp = Layer.effect(
  DescribeFargateProfile,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribeFargateProfile",
    operation: eks.describeFargateProfile,
    actions: ["eks:DescribeFargateProfile"],
    key: "clusterName",
    scope: "subresources",
  }),
);
