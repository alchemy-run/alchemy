import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetEventRouteRequest extends Omit<dt.GetEventRouteByIdRequest, "endpoint"> {}

/**
 * Read an event route.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsEventRouteReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/eventroutes/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetEventRouteHttp}.
 *
 * ### Calling GetEventRoute
 * **Example:** GetEventRoute from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const getEventRoute = yield* Azure.DigitalTwins.GetEventRoute(twins);
 *
 * // runtime
 * const route = yield* getEventRoute({ id: "all-to-grid" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.GetEventRouteHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface GetEventRoute extends Binding.Service<
  GetEventRoute,
  "Azure.DigitalTwins.GetEventRoute",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetEventRouteRequest,
    ) => Effect.Effect<dt.EventRoute, dt.GetEventRouteByIdError, RuntimeContext>
  >
> {}

export const GetEventRoute = Binding.Service<GetEventRoute>("Azure.DigitalTwins.GetEventRoute");
