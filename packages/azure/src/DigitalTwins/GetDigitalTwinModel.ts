import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDigitalTwinModelRequest extends Omit<
  dt.GetDigitalTwinModelByIdRequest,
  "endpoint"
> {}

/**
 * Read a model's metadata (and its definition with `includeModelDefinition`).
 *
 * Binding assigns a custom role (`AzureDigitalTwinsModelReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/models/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetDigitalTwinModelHttp}.
 *
 * ### Calling GetDigitalTwinModel
 * **Example:** GetDigitalTwinModel from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const getDigitalTwinModel = yield* Azure.DigitalTwins.GetDigitalTwinModel(twins);
 *
 * // runtime
 * const model = yield* getDigitalTwinModel({ id: "dtmi:example:Room;1", includeModelDefinition: true });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.GetDigitalTwinModelHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface GetDigitalTwinModel extends Binding.Service<
  GetDigitalTwinModel,
  "Azure.DigitalTwins.GetDigitalTwinModel",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDigitalTwinModelRequest,
    ) => Effect.Effect<dt.DigitalTwinsModelData, dt.GetDigitalTwinModelByIdError, RuntimeContext>
  >
> {}

export const GetDigitalTwinModel = Binding.Service<GetDigitalTwinModel>(
  "Azure.DigitalTwins.GetDigitalTwinModel",
);
