import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `AttestationAttestOpenEnclave` request without the attest URI, which the bound provider supplies. */
export interface AttestOpenEnclaveRequest extends Omit<
  att.AttestationAttestOpenEnclaveRequest,
  "endpoint"
> {}

/**
 * Attest an Open Enclave SDK enclave: send its report (and runtime data) and
 * get a signed attestation token.
 *
 * The endpoint needs no role, so the binding assigns none; the host still
 * calls it with its Azure identity.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AttestOpenEnclaveHttp}.
 *
 * ### Calling AttestOpenEnclave
 * **Example:** AttestOpenEnclave from a Function
 * ```typescript
 * // init
 * const attestOpenEnclave = yield* Azure.Attestation.AttestOpenEnclave(provider);
 *
 * // runtime
 * const result = yield* attestOpenEnclave({ report, runtimeData: { data: runtimeData, dataType: "Binary" } });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface AttestOpenEnclave extends Binding.Service<
  AttestOpenEnclave,
  "Azure.Attestation.AttestOpenEnclave",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: AttestOpenEnclaveRequest,
    ) => Effect.Effect<
      att.AttestationResponse,
      att.AttestationAttestOpenEnclaveError,
      RuntimeContext
    >
  >
> {}

export const AttestOpenEnclave = Binding.Service<AttestOpenEnclave>(
  "Azure.Attestation.AttestOpenEnclave",
);
