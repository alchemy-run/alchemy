import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateDigitalTwinRequest extends Omit<dt.UpdateDigitalTwinRequest, "endpoint"> {}

/**
 * Update a digital twin with a JSON Patch document.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsTwinWriteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/write`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateDigitalTwinHttp}.
 *
 * ### Calling UpdateDigitalTwin
 * **Example:** UpdateDigitalTwin from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const updateDigitalTwin = yield* Azure.DigitalTwins.UpdateDigitalTwin(twins);
 *
 * // runtime
 * yield* updateDigitalTwin({
 *   id: "room-1",
 *   body: [{ op: "replace", path: "/temperature", value: 22 }],
 * });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.UpdateDigitalTwinHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface UpdateDigitalTwin extends Binding.Service<
  UpdateDigitalTwin,
  "Azure.DigitalTwins.UpdateDigitalTwin",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: UpdateDigitalTwinRequest,
    ) => Effect.Effect<dt.UpdateDigitalTwinResponse, dt.UpdateDigitalTwinError, RuntimeContext>
  >
> {}

export const UpdateDigitalTwin = Binding.Service<UpdateDigitalTwin>(
  "Azure.DigitalTwins.UpdateDigitalTwin",
);
