import type * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DeidService } from "./DeidService.ts";

/**
 * `DeidentifyText` request without `endpoint`, which the bound
 * de-identification service (its `serviceUrl`) supplies.
 */
export interface DeidentifyTextRequest extends Omit<deid.DeidentifyTextRequest, "endpoint"> {}

/**
 * De-identify a text in one call (`POST /deid`): redact, replace with
 * surrogates, or tag the PHI entities it finds.
 *
 * Binding assigns the built-in **DeID Realtime Data User** role (data action
 * `Microsoft.HealthDataAIServices/DeidServices/Realtime/action` only) on the
 * bound service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeidentifyTextHttp}.
 *
 * ### Calling DeidentifyText
 * **Example:** DeidentifyText from a Function
 * ```typescript
 * // init
 * const service = yield* Azure.HealthDataAIServices.DeidService("deid", { resourceGroup: group.resourceGroupName });
 * const deidentifyText = yield* Azure.HealthDataAIServices.DeidentifyText(service);
 *
 * // runtime
 * const result = yield* deidentifyText({ inputText: "Hello, my name is John Smith.", operation: "Surrogate" });
 *
 * // layer
 * Effect.provide(Azure.HealthDataAIServices.DeidentifyTextHttp)
 * ```
 *
 * @binding
 * @category HealthDataAIServices
 */
export interface DeidentifyText extends Binding.Service<
  DeidentifyText,
  "Azure.HealthDataAIServices.DeidentifyText",
  (
    service: DeidService,
  ) => Effect.Effect<
    (
      request: DeidentifyTextRequest,
    ) => Effect.Effect<deid.DeidentificationResult, deid.DeidentifyTextError, RuntimeContext>
  >
> {}

export const DeidentifyText = Binding.Service<DeidentifyText>(
  "Azure.HealthDataAIServices.DeidentifyText",
);
