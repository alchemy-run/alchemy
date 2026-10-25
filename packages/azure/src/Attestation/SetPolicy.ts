import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `SetPolicy` request without the attest URI, which the bound provider supplies. */
export interface SetPolicyRequest extends Omit<att.SetPolicyRequest, "endpoint"> {}

/**
 * Set the attestation policy of a provider for one TEE type. On an `AAD`
 * provider `body` is an unsigned JWS whose payload is `{
 * "AttestationPolicy": base64url(policy) }`; on an `Isolated` provider it is
 * signed with a policy signing key.
 *
 * Binding assigns a custom role (`AzureAttestationPolicyWriteRole`, one per
 * stack) with exactly the action `attestationProviders/attestation/write`,
 * on the provider only. The smallest built-in role, **Attestation
 * Contributor**, also reads and deletes.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SetPolicyHttp}.
 *
 * ### Calling SetPolicy
 * **Example:** SetPolicy from a Function
 * ```typescript
 * // init
 * const setPolicy = yield* Azure.Attestation.SetPolicy(provider);
 *
 * // runtime
 * const result = yield* setPolicy({ attestationType: "SgxEnclave", body: policyJws });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface SetPolicy extends Binding.Service<
  SetPolicy,
  "Azure.Attestation.SetPolicy",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: SetPolicyRequest,
    ) => Effect.Effect<att.PolicyResponse, att.SetPolicyError, RuntimeContext>
  >
> {}

export const SetPolicy = Binding.Service<SetPolicy>("Azure.Attestation.SetPolicy");
