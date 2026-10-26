import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetSasToken` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface GetSasTokenRequest extends Omit<geocatalog.GetSasTokenRequest, "endpoint"> {}

/**
 * Get a SAS token for a collection's storage, to read its assets directly.
 *
 * The `token` comes back `Redacted`; read it with `Redacted.value` where
 * you use it.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetSasTokenHttp}.
 *
 * ### Calling GetSasToken
 * **Example:** GetSasToken from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getSasToken = yield* Azure.PlanetaryComputer.GetSasToken(catalog);
 *
 * // runtime
 * const result = yield* getSasToken({ collectionId: "sentinel-2" });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetSasTokenHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetSasToken extends Binding.Service<
  GetSasToken,
  "Azure.PlanetaryComputer.GetSasToken",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetSasTokenRequest,
    ) => Effect.Effect<
      geocatalog.SharedAccessSignatureToken,
      geocatalog.GetSasTokenError,
      RuntimeContext
    >
  >
> {}

export const GetSasToken = Binding.Service<GetSasToken>("Azure.PlanetaryComputer.GetSasToken");
