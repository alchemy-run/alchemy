import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `AttestationAttestTpm` request without the attest URI, which the bound provider supplies. */
export interface AttestTpmRequest extends Omit<att.AttestationAttestTpmRequest, "endpoint"> {}

/**
 * Run one step of the TPM attestation protocol (the provider answers with
 * the next protocol message, then the token).
 *
 * The endpoint needs no role, so the binding assigns none; the host still
 * calls it with its Azure identity.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AttestTpmHttp}.
 *
 * ### Calling AttestTpm
 * **Example:** AttestTpm from a Function
 * ```typescript
 * // init
 * const attestTpm = yield* Azure.Attestation.AttestTpm(provider);
 *
 * // runtime
 * const result = yield* attestTpm({ data: protocolMessage });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface AttestTpm extends Binding.Service<
  AttestTpm,
  "Azure.Attestation.AttestTpm",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: AttestTpmRequest,
    ) => Effect.Effect<att.TpmAttestationResponse, att.AttestationAttestTpmError, RuntimeContext>
  >
> {}

export const AttestTpm = Binding.Service<AttestTpm>("Azure.Attestation.AttestTpm");
