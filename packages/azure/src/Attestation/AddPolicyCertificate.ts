import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `AddPolicyCertificate` request without the attest URI, which the bound provider supplies. */
export interface AddPolicyCertificateRequest extends Omit<
  att.AddPolicyCertificateRequest,
  "endpoint"
> {}

/**
 * Add a policy management certificate to an `Isolated` provider.
 * `policyCertificateToAdd` is a JWS signed by an existing policy management
 * key.
 *
 * Binding assigns a custom role (`AzureAttestationPolicyWriteRole`, one per
 * stack) with exactly the action `attestationProviders/attestation/write`,
 * on the provider only. The smallest built-in role, **Attestation
 * Contributor**, also reads and deletes.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AddPolicyCertificateHttp}.
 *
 * ### Calling AddPolicyCertificate
 * **Example:** AddPolicyCertificate from a Function
 * ```typescript
 * // init
 * const addPolicyCertificate = yield* Azure.Attestation.AddPolicyCertificate(provider);
 *
 * // runtime
 * const result = yield* addPolicyCertificate({ policyCertificateToAdd: signedJws });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface AddPolicyCertificate extends Binding.Service<
  AddPolicyCertificate,
  "Azure.Attestation.AddPolicyCertificate",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: AddPolicyCertificateRequest,
    ) => Effect.Effect<
      att.PolicyCertificatesModifyResponse,
      att.AddPolicyCertificateError,
      RuntimeContext
    >
  >
> {}

export const AddPolicyCertificate = Binding.Service<AddPolicyCertificate>(
  "Azure.Attestation.AddPolicyCertificate",
);
