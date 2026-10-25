import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `GetMetadataConfiguration` request without the attest URI, which the bound provider supplies. */
export interface GetMetadataConfigurationRequest extends Omit<
  att.GetMetadataConfigurationRequest,
  "endpoint"
> {}

/**
 * Get the provider's OpenID metadata document (issuer, JWKS URI, supported
 * algorithms).
 *
 * The endpoint needs no role, so the binding assigns none; the host still
 * calls it with its Azure identity.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetMetadataConfigurationHttp}.
 *
 * ### Calling GetMetadataConfiguration
 * **Example:** GetMetadataConfiguration from a Function
 * ```typescript
 * // init
 * const getMetadataConfiguration = yield* Azure.Attestation.GetMetadataConfiguration(provider);
 *
 * // runtime
 * const result = yield* getMetadataConfiguration();
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface GetMetadataConfiguration extends Binding.Service<
  GetMetadataConfiguration,
  "Azure.Attestation.GetMetadataConfiguration",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request?: GetMetadataConfigurationRequest,
    ) => Effect.Effect<
      att.OpenIDConfigurationResponse,
      att.GetMetadataConfigurationError,
      RuntimeContext
    >
  >
> {}

export const GetMetadataConfiguration = Binding.Service<GetMetadataConfiguration>(
  "Azure.Attestation.GetMetadataConfiguration",
);
