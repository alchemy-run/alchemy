import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `GetPolicy` request without the attest URI, which the bound provider supplies. */
export interface GetPolicyRequest extends Omit<att.GetPolicyRequest, "endpoint"> {}

/**
 * Read the attestation policy a provider applies to one TEE type. The result
 * is a JWT whose body carries the policy.
 *
 * Binding assigns a custom role (`AzureAttestationPolicyReadRole`, one per
 * stack) with exactly the action `attestationProviders/attestation/read`, on
 * the provider only. The smallest built-in role, **Attestation Reader**,
 * also reads the provider resource.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetPolicyHttp}.
 *
 * ### Calling GetPolicy
 * **Example:** GetPolicy from a Function
 * ```typescript
 * // init
 * const getPolicy = yield* Azure.Attestation.GetPolicy(provider);
 *
 * // runtime
 * const result = yield* getPolicy({ attestationType: "SgxEnclave" });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface GetPolicy extends Binding.Service<
  GetPolicy,
  "Azure.Attestation.GetPolicy",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: GetPolicyRequest,
    ) => Effect.Effect<att.PolicyResponse, att.GetPolicyError, RuntimeContext>
  >
> {}

export const GetPolicy = Binding.Service<GetPolicy>("Azure.Attestation.GetPolicy");
