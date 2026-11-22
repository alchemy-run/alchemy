import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `ResetPolicy` request without the attest URI, which the bound provider supplies. */
export interface ResetPolicyRequest extends Omit<att.ResetPolicyRequest, "endpoint"> {}

/**
 * Reset the attestation policy of a provider for one TEE type to the
 * default. On an `AAD` provider `body` is the unsigned JWS
 * `eyJhbGciOiJub25lIn0..`.
 *
 * Binding assigns a custom role (`AzureAttestationPolicyWriteRole`, one per
 * stack) with exactly the action `attestationProviders/attestation/write`,
 * on the provider only. The smallest built-in role, **Attestation
 * Contributor**, also reads and deletes.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ResetPolicyHttp}.
 *
 * ### Calling ResetPolicy
 * **Example:** ResetPolicy from a Function
 * ```typescript
 * // init
 * const resetPolicy = yield* Azure.Attestation.ResetPolicy(provider);
 *
 * // runtime
 * const result = yield* resetPolicy({ attestationType: "SgxEnclave", body: "eyJhbGciOiJub25lIn0.." });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface ResetPolicy extends Binding.Service<
  ResetPolicy,
  "Azure.Attestation.ResetPolicy",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: ResetPolicyRequest,
    ) => Effect.Effect<att.PolicyResponse, att.ResetPolicyError, RuntimeContext>
  >
> {}

export const ResetPolicy = Binding.Service<ResetPolicy>("Azure.Attestation.ResetPolicy");
