import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `AttestationAttestSgxEnclave` request without the attest URI, which the bound provider supplies. */
export interface AttestSgxEnclaveRequest extends Omit<
  att.AttestationAttestSgxEnclaveRequest,
  "endpoint"
> {}

/**
 * Attest an Intel SGX enclave: send its quote (and runtime data) and get a
 * signed attestation token.
 *
 * The endpoint needs no role, so the binding assigns none; the host still
 * calls it with its Azure identity.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AttestSgxEnclaveHttp}.
 *
 * ### Calling AttestSgxEnclave
 * **Example:** AttestSgxEnclave from a Function
 * ```typescript
 * // init
 * const attestSgxEnclave = yield* Azure.Attestation.AttestSgxEnclave(provider);
 *
 * // runtime
 * const result = yield* attestSgxEnclave({ quote, runtimeData: { data: runtimeData, dataType: "Binary" } });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface AttestSgxEnclave extends Binding.Service<
  AttestSgxEnclave,
  "Azure.Attestation.AttestSgxEnclave",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: AttestSgxEnclaveRequest,
    ) => Effect.Effect<
      att.AttestationResponse,
      att.AttestationAttestSgxEnclaveError,
      RuntimeContext
    >
  >
> {}

export const AttestSgxEnclave = Binding.Service<AttestSgxEnclave>(
  "Azure.Attestation.AttestSgxEnclave",
);
