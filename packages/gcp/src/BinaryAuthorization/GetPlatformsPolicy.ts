import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import type { PlatformsPolicy } from "./PlatformsPolicy.ts";

export interface GetPlatformsPolicyRequest extends Omit<
  binaryauthorization.GetProjectsPlatformsPoliciesRequest,
  "name"
> {}

/**
 * Runtime binding for Binary Authorization `platforms.policies.get`.
 *
 * Bind this operation to a {@link PlatformsPolicy} in a Function/Action
 * init phase. Provide {@link GetPlatformsPolicyHttp}.
 *
 * ### Reading a Platform Policy
 * **Example:** Get the bound policy
 * ```typescript
 * const getPolicy = yield* GCP.BinaryAuthorization.GetPlatformsPolicy(
 *   policy,
 * );
 * const live = yield* getPolicy();
 * ```
 *
 * @binding
 * @category BinaryAuthorization
 */
export interface GetPlatformsPolicy extends Binding.Service<
  GetPlatformsPolicy,
  "GCP.BinaryAuthorization.GetPlatformsPolicy",
  (
    policy: PlatformsPolicy,
  ) => Effect.Effect<
    (
      request?: GetPlatformsPolicyRequest,
    ) => Effect.Effect<
      binaryauthorization.PlatformPolicy,
      binaryauthorization.GetProjectsPlatformsPoliciesError,
      RuntimeContext
    >
  >
> {}

export const GetPlatformsPolicy = Binding.Service<GetPlatformsPolicy>(
  "GCP.BinaryAuthorization.GetPlatformsPolicy",
);

/**
 * HTTP implementation of {@link GetPlatformsPolicy}.
 *
 * @layer
 * @provides GCP.BinaryAuthorization.GetPlatformsPolicy
 */
export const GetPlatformsPolicyHttp = Layer.effect(
  GetPlatformsPolicy,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getPolicy = yield* GCPBindings.withCredentials(
      binaryauthorization.getProjectsPlatformsPolicies,
    );
    return Effect.fn(function* (policy: PlatformsPolicy) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.BinaryAuthorization.GetPlatformsPolicy(${policy})`({
          // Platform policies have no resource-level IAM.
          iam: [{ role: "roles/binaryauthorization.policyViewer" }],
        });
      }
      const name = yield* policy.name;
      return Effect.fn(`GCP.BinaryAuthorization.GetPlatformsPolicy(${policy.LogicalId})`)(
        function* (request?: GetPlatformsPolicyRequest) {
          return yield* getPolicy({
            ...request,
            name: yield* name,
          });
        },
      );
    });
  }),
);
