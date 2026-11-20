import * as redis from "@distilled.cloud/gcp/redis_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AclPolicy } from "./AclPolicy.ts";
import { makeRedisHttpBinding } from "./BindingHttp.ts";

export interface GetAclPolicyRequest extends Omit<
  redis.GetProjectsLocationsAclPoliciesRequest,
  "name"
> {}

/**
 * Runtime binding for Memorystore Redis `aclPolicies.get`.
 *
 * Bind this operation to an {@link AclPolicy} in a Function/Action init
 * phase. Provide {@link GetAclPolicyHttp}.
 *
 * ### Observing ACL Policies
 * **Example:** Read the bound policy
 * ```typescript
 * const getAclPolicy = yield* GCP.Redis.GetAclPolicy(policy);
 * const live = yield* getAclPolicy();
 * ```
 *
 * @binding
 * @category Redis
 */
export interface GetAclPolicy extends Binding.Service<
  GetAclPolicy,
  "GCP.Redis.GetAclPolicy",
  (
    policy: AclPolicy,
  ) => Effect.Effect<
    (
      request?: GetAclPolicyRequest,
    ) => Effect.Effect<redis.AclPolicy, redis.GetProjectsLocationsAclPoliciesError, RuntimeContext>
  >
> {}

export const GetAclPolicy = Binding.Service<GetAclPolicy>("GCP.Redis.GetAclPolicy");

/**
 * HTTP implementation of {@link GetAclPolicy}.
 *
 * @layer
 * @provides GCP.Redis.GetAclPolicy
 */
export const GetAclPolicyHttp = Layer.effect(
  GetAclPolicy,
  makeRedisHttpBinding({
    tag: "GCP.Redis.GetAclPolicy",
    operation: redis.getProjectsLocationsAclPolicies,
  }),
);
