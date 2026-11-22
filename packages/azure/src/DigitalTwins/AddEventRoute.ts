import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface AddEventRouteRequest extends Omit<dt.AddEventRouteRequest, "endpoint"> {}

/**
 * Create or replace an event route to one of the instance's endpoints.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsEventRouteWriteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/eventroutes/write`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AddEventRouteHttp}.
 *
 * ### Calling AddEventRoute
 * **Example:** AddEventRoute from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const addEventRoute = yield* Azure.DigitalTwins.AddEventRoute(twins);
 *
 * // runtime
 * yield* addEventRoute({ id: "all-to-grid", endpointName: "grid", filter: "true" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.AddEventRouteHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface AddEventRoute extends Binding.Service<
  AddEventRoute,
  "Azure.DigitalTwins.AddEventRoute",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: AddEventRouteRequest,
    ) => Effect.Effect<dt.AddEventRouteResponse, dt.AddEventRouteError, RuntimeContext>
  >
> {}

export const AddEventRoute = Binding.Service<AddEventRoute>("Azure.DigitalTwins.AddEventRoute");
