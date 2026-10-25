import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `GetSigningCertificate` request without the attest URI, which the bound provider supplies. */
export interface GetSigningCertificateRequest extends Omit<
  att.GetSigningCertificateRequest,
  "endpoint"
> {}

/**
 * Get the keys (a JSON Web Key Set) that sign the provider's attestation
 * tokens, to verify them.
 *
 * The endpoint needs no role, so the binding assigns none; the host still
 * calls it with its Azure identity.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetSigningCertificateHttp}.
 *
 * ### Calling GetSigningCertificate
 * **Example:** GetSigningCertificate from a Function
 * ```typescript
 * // init
 * const getSigningCertificate = yield* Azure.Attestation.GetSigningCertificate(provider);
 *
 * // runtime
 * const result = yield* getSigningCertificate();
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface GetSigningCertificate extends Binding.Service<
  GetSigningCertificate,
  "Azure.Attestation.GetSigningCertificate",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request?: GetSigningCertificateRequest,
    ) => Effect.Effect<att.JsonWebKeySet, att.GetSigningCertificateError, RuntimeContext>
  >
> {}

export const GetSigningCertificate = Binding.Service<GetSigningCertificate>(
  "Azure.Attestation.GetSigningCertificate",
);
