import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateDigitalTwinModelRequest extends Omit<
  dt.UpdateDigitalTwinModelRequest,
  "endpoint"
> {}

/**
 * Update a model; the only supported patch decommissions it.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsModelWriteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/models/write`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateDigitalTwinModelHttp}.
 *
 * ### Calling UpdateDigitalTwinModel
 * **Example:** UpdateDigitalTwinModel from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const updateDigitalTwinModel = yield* Azure.DigitalTwins.UpdateDigitalTwinModel(twins);
 *
 * // runtime
 * yield* updateDigitalTwinModel({
 *   id: "dtmi:example:Room;1",
 *   body: [{ op: "replace", path: "/decommissioned", value: true }],
 * });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.UpdateDigitalTwinModelHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface UpdateDigitalTwinModel extends Binding.Service<
  UpdateDigitalTwinModel,
  "Azure.DigitalTwins.UpdateDigitalTwinModel",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: UpdateDigitalTwinModelRequest,
    ) => Effect.Effect<
      dt.UpdateDigitalTwinModelResponse,
      dt.UpdateDigitalTwinModelError,
      RuntimeContext
    >
  >
> {}

export const UpdateDigitalTwinModel = Binding.Service<UpdateDigitalTwinModel>(
  "Azure.DigitalTwins.UpdateDigitalTwinModel",
);
