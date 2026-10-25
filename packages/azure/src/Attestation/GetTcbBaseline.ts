import type * as att from "@distilled.cloud/azure/attestation-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Provider } from "./Provider.ts";

/** `GetTcbBaseline` request without the attest URI, which the bound provider supplies. */
export interface GetTcbBaselineRequest extends Omit<att.GetTcbBaselineRequest, "endpoint"> {}

/**
 * List the TCB baselines Azure supports for one TEE type and which one the
 * provider enforces.
 *
 * Binding assigns a custom role (`AzureAttestationPolicyReadRole`, one per
 * stack) with exactly the action `attestationProviders/attestation/read`, on
 * the provider only. The smallest built-in role, **Attestation Reader**,
 * also reads the provider resource.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetTcbBaselineHttp}.
 *
 * ### Calling GetTcbBaseline
 * **Example:** GetTcbBaseline from a Function
 * ```typescript
 * // init
 * const getTcbBaseline = yield* Azure.Attestation.GetTcbBaseline(provider);
 *
 * // runtime
 * const result = yield* getTcbBaseline({ attestationType: "SgxEnclave" });
 * ```
 *
 * @binding
 * @category Attestation
 */
export interface GetTcbBaseline extends Binding.Service<
  GetTcbBaseline,
  "Azure.Attestation.GetTcbBaseline",
  (
    provider: Provider,
  ) => Effect.Effect<
    (
      request: GetTcbBaselineRequest,
    ) => Effect.Effect<att.TcbBaselineResult, att.GetTcbBaselineError, RuntimeContext>
  >
> {}

export const GetTcbBaseline = Binding.Service<GetTcbBaseline>("Azure.Attestation.GetTcbBaseline");
