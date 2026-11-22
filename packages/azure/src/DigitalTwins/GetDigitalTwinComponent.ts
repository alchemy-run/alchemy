import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDigitalTwinComponentRequest extends Omit<
  dt.GetDigitalTwinComponentRequest,
  "endpoint"
> {}

/**
 * Read one component of a digital twin.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsTwinReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetDigitalTwinComponentHttp}.
 *
 * ### Calling GetDigitalTwinComponent
 * **Example:** GetDigitalTwinComponent from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const getDigitalTwinComponent = yield* Azure.DigitalTwins.GetDigitalTwinComponent(twins);
 *
 * // runtime
 * const thermostat = yield* getDigitalTwinComponent({ id: "room-1", componentPath: "thermostat" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.GetDigitalTwinComponentHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface GetDigitalTwinComponent extends Binding.Service<
  GetDigitalTwinComponent,
  "Azure.DigitalTwins.GetDigitalTwinComponent",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDigitalTwinComponentRequest,
    ) => Effect.Effect<
      dt.GetDigitalTwinComponentResponse,
      dt.GetDigitalTwinComponentError,
      RuntimeContext
    >
  >
> {}

export const GetDigitalTwinComponent = Binding.Service<GetDigitalTwinComponent>(
  "Azure.DigitalTwins.GetDigitalTwinComponent",
);
