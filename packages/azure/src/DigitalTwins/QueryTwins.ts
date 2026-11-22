import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface QueryTwinsRequest extends Omit<dt.QueryQueryTwinsRequest, "endpoint"> {}

/**
 * Run a Digital Twins query over the twin graph (one page; pass `continuationToken` for the next).
 *
 * Binding assigns a custom role (`AzureDigitalTwinsQueryRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/query/action`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link QueryTwinsHttp}.
 *
 * ### Calling QueryTwins
 * **Example:** QueryTwins from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const queryTwins = yield* Azure.DigitalTwins.QueryTwins(twins);
 *
 * // runtime
 * const result = yield* queryTwins({ query: "SELECT * FROM digitaltwins" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.QueryTwinsHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface QueryTwins extends Binding.Service<
  QueryTwins,
  "Azure.DigitalTwins.QueryTwins",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: QueryTwinsRequest,
    ) => Effect.Effect<dt.QueryResult, dt.QueryQueryTwinsError, RuntimeContext>
  >
> {}

export const QueryTwins = Binding.Service<QueryTwins>("Azure.DigitalTwins.QueryTwins");
