import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `AttestationAttestAzureGuest` request without the attest URI, which the bound provider supplies. */
export interface AttestAzureGuestRequest extends Omit<
  att.AttestationAttestAzureGuestRequest,
  "endpoint"
> {}

/**
 * Attest an Azure confidential VM guest from the guest attestation client's
 * evidence and get a sealed attestation token.
 *
 * The endpoint needs no role, so the binding assigns none; the host still
 * calls it with its Azure identity.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AttestAzureGuestHttp}.
 *
 * ### Calling AttestAzureGuest
 * **Example:** AttestAzureGuest from a Function
 * ```typescript
 * // init
 * const attestAzureGuest = yield* Azure.Attestation.AttestAzureGuest(provider);
 *
 * // runtime
 * const result = yield* attestAzureGuest({ attestationInfo });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface AttestAzureGuest extends Binding.Service<
  AttestAzureGuest,
  "Azure.Attestation.AttestAzureGuest",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: AttestAzureGuestRequest,
    ) => Effect.Effect<
      att.SealedAttestationResponse,
      att.AttestationAttestAzureGuestError,
      RuntimeContext
    >
  >
> {}

export const AttestAzureGuest = Binding.Service<AttestAzureGuest>(
  "Azure.Attestation.AttestAzureGuest",
);
