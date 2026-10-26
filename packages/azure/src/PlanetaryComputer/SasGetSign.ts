import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `SasGetSign` request without `endpoint`, which the bound GeoCatalog (its
 * `catalogUri`) supplies.
 */
export interface SasGetSignRequest extends Omit<geocatalog.SasGetSignRequest, "endpoint"> {}

/**
 * Sign an asset URL with a SAS token.
 *
 * The signed `href` carries the SAS token, so it comes back `Redacted`;
 * read it with `Redacted.value` where you use it.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SasGetSignHttp}.
 *
 * ### Calling SasGetSign
 * **Example:** SasGetSign from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const sasGetSign = yield* Azure.PlanetaryComputer.SasGetSign(catalog);
 *
 * // runtime
 * const result = yield* sasGetSign({ href: assetUrl });
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.SasGetSignHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface SasGetSign extends Binding.Service<
  SasGetSign,
  "Azure.PlanetaryComputer.SasGetSign",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: SasGetSignRequest,
    ) => Effect.Effect<
      geocatalog.SharedAccessSignatureSignedLink,
      geocatalog.SasGetSignError,
      RuntimeContext
    >
  >
> {}

export const SasGetSign = Binding.Service<SasGetSign>("Azure.PlanetaryComputer.SasGetSign");
