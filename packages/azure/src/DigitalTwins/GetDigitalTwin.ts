import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDigitalTwinRequest extends Omit<dt.GetDigitalTwinByIdRequest, "endpoint"> {}

/**
 * Read a digital twin (its `$metadata` and property values).
 *
 * Binding assigns a custom role (`AzureDigitalTwinsTwinReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetDigitalTwinHttp}.
 *
 * ### Calling GetDigitalTwin
 * **Example:** GetDigitalTwin from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const getDigitalTwin = yield* Azure.DigitalTwins.GetDigitalTwin(twins);
 *
 * // runtime
 * const twin = yield* getDigitalTwin({ id: "room-1" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.GetDigitalTwinHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface GetDigitalTwin extends Binding.Service<
  GetDigitalTwin,
  "Azure.DigitalTwins.GetDigitalTwin",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDigitalTwinRequest,
    ) => Effect.Effect<dt.GetDigitalTwinByIdResponse, dt.GetDigitalTwinByIdError, RuntimeContext>
  >
> {}

export const GetDigitalTwin = Binding.Service<GetDigitalTwin>("Azure.DigitalTwins.GetDigitalTwin");
