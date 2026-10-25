import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `AttestationAttestSevSnpVm` request without the attest URI, which the bound provider supplies. */
export interface AttestSevSnpVmRequest extends Omit<
  att.AttestationAttestSevSnpVmRequest,
  "endpoint"
> {}

/**
 * Attest an AMD SEV-SNP confidential VM: send its hardware report and get a
 * signed attestation token.
 *
 * The endpoint needs no role, so the binding assigns none; the host still
 * calls it with its Azure identity.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AttestSevSnpVmHttp}.
 *
 * ### Calling AttestSevSnpVm
 * **Example:** AttestSevSnpVm from a Function
 * ```typescript
 * // init
 * const attestSevSnpVm = yield* Azure.Attestation.AttestSevSnpVm(provider);
 *
 * // runtime
 * const result = yield* attestSevSnpVm({ report });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface AttestSevSnpVm extends Binding.Service<
  AttestSevSnpVm,
  "Azure.Attestation.AttestSevSnpVm",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: AttestSevSnpVmRequest,
    ) => Effect.Effect<att.AttestationResponse, att.AttestationAttestSevSnpVmError, RuntimeContext>
  >
> {}

export const AttestSevSnpVm = Binding.Service<AttestSevSnpVm>("Azure.Attestation.AttestSevSnpVm");
