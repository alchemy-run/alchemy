import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListEventRoutesRequest extends Omit<dt.ListEventRoutesRequest, "endpoint"> {}

/**
 * List one page of the instance's event routes.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsEventRouteReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/eventroutes/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListEventRoutesHttp}.
 *
 * ### Calling ListEventRoutes
 * **Example:** ListEventRoutes from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const listEventRoutes = yield* Azure.DigitalTwins.ListEventRoutes(twins);
 *
 * // runtime
 * const page = yield* listEventRoutes();
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.ListEventRoutesHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface ListEventRoutes extends Binding.Service<
  ListEventRoutes,
  "Azure.DigitalTwins.ListEventRoutes",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListEventRoutesRequest,
    ) => Effect.Effect<dt.EventRouteCollection, dt.ListEventRoutesError, RuntimeContext>
  >
> {}

export const ListEventRoutes = Binding.Service<ListEventRoutes>(
  "Azure.DigitalTwins.ListEventRoutes",
);
