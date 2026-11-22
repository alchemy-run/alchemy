import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `RevokeSasToken` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface RevokeSasTokenRequest extends Omit<geocatalog.RevokeSasTokenRequest, "endpoint"> {}

/**
 * Revoke the catalog's SAS tokens.
 *
 * Binding assigns the built-in **GeoCatalog Administrator** role on the bound
 * catalog only: the only role the GeoCatalog data plane accepts for writes
 * (`Microsoft.Orbital` has no data actions, so no narrower custom role exists).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RevokeSasTokenHttp}.
 *
 * ### Calling RevokeSasToken
 * **Example:** RevokeSasToken from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const revokeSasToken = yield* Azure.PlanetaryComputer.RevokeSasToken(catalog);
 *
 * // runtime
 * const result = yield* revokeSasToken();
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.RevokeSasTokenHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface RevokeSasToken extends Binding.Service<
  RevokeSasToken,
  "Azure.PlanetaryComputer.RevokeSasToken",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request?: RevokeSasTokenRequest,
    ) => Effect.Effect<
      geocatalog.RevokeSasTokenResponse,
      geocatalog.RevokeSasTokenError,
      RuntimeContext
    >
  >
> {}

export const RevokeSasToken = Binding.Service<RevokeSasToken>(
  "Azure.PlanetaryComputer.RevokeSasToken",
);
