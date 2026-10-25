import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteEventRouteRequest extends Omit<dt.DeleteEventRouteRequest, "endpoint"> {}

/**
 * Delete an event route.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsEventRouteDeleteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/eventroutes/delete`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteEventRouteHttp}.
 *
 * ### Calling DeleteEventRoute
 * **Example:** DeleteEventRoute from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const deleteEventRoute = yield* Azure.DigitalTwins.DeleteEventRoute(twins);
 *
 * // runtime
 * yield* deleteEventRoute({ id: "all-to-grid" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.DeleteEventRouteHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface DeleteEventRoute extends Binding.Service<
  DeleteEventRoute,
  "Azure.DigitalTwins.DeleteEventRoute",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteEventRouteRequest,
    ) => Effect.Effect<dt.DeleteEventRouteResponse, dt.DeleteEventRouteError, RuntimeContext>
  >
> {}

export const DeleteEventRoute = Binding.Service<DeleteEventRoute>(
  "Azure.DigitalTwins.DeleteEventRoute",
);
