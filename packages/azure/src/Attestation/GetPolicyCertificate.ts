import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `GetPolicyCertificate` request without the attest URI, which the bound provider supplies. */
export interface GetPolicyCertificateRequest extends Omit<
  att.GetPolicyCertificateRequest,
  "endpoint"
> {}

/**
 * Read the policy management certificates of an `Isolated` provider (a JWT
 * listing them).
 *
 * Binding assigns a custom role (`AzureAttestationPolicyReadRole`, one per
 * stack) with exactly the action `attestationProviders/attestation/read`, on
 * the provider only. The smallest built-in role, **Attestation Reader**,
 * also reads the provider resource.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetPolicyCertificateHttp}.
 *
 * ### Calling GetPolicyCertificate
 * **Example:** GetPolicyCertificate from a Function
 * ```typescript
 * // init
 * const getPolicyCertificate = yield* Azure.Attestation.GetPolicyCertificate(provider);
 *
 * // runtime
 * const result = yield* getPolicyCertificate();
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface GetPolicyCertificate extends Binding.Service<
  GetPolicyCertificate,
  "Azure.Attestation.GetPolicyCertificate",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request?: GetPolicyCertificateRequest,
    ) => Effect.Effect<
      att.PolicyCertificatesResponse,
      att.GetPolicyCertificateError,
      RuntimeContext
    >
  >
> {}

export const GetPolicyCertificate = Binding.Service<GetPolicyCertificate>(
  "Azure.Attestation.GetPolicyCertificate",
);
