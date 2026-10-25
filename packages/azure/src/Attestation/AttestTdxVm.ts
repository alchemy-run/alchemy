import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `AttestationAttestTdxVm` request without the attest URI, which the bound provider supplies. */
export interface AttestTdxVmRequest extends Omit<att.AttestationAttestTdxVmRequest, "endpoint"> {}

/**
 * Attest an Intel TDX confidential VM: send its quote and get a signed
 * attestation token.
 *
 * The endpoint needs no role, so the binding assigns none; the host still
 * calls it with its Azure identity.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AttestTdxVmHttp}.
 *
 * ### Calling AttestTdxVm
 * **Example:** AttestTdxVm from a Function
 * ```typescript
 * // init
 * const attestTdxVm = yield* Azure.Attestation.AttestTdxVm(provider);
 *
 * // runtime
 * const result = yield* attestTdxVm({ quote });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface AttestTdxVm extends Binding.Service<
  AttestTdxVm,
  "Azure.Attestation.AttestTdxVm",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: AttestTdxVmRequest,
    ) => Effect.Effect<att.AttestationResponse, att.AttestationAttestTdxVmError, RuntimeContext>
  >
> {}

export const AttestTdxVm = Binding.Service<AttestTdxVm>("Azure.Attestation.AttestTdxVm");
