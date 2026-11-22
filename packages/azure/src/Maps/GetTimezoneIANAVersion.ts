import type * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetTimezoneIANAVersion` request; the bound account supplies `x-ms-client-id`. */
export interface GetTimezoneIANAVersionRequest extends Omit<
  timezone.GetTimezoneTimezoneIANAVersionRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetTimezoneIANAVersion}. */
export type GetTimezoneIANAVersionClient = (
  request: GetTimezoneIANAVersionRequest,
) => Effect.Effect<
  timezone.TimezoneIanaVersionResult,
  timezone.GetTimezoneTimezoneIANAVersionError,
  RuntimeContext
>;

/**
 * Get the IANA time zone database version Maps uses. Calls Azure Maps from any host with Microsoft Entra ID,
 * sending the bound account's unique ID as `x-ms-client-id`.
 *
 * Binding assigns a custom role (`AzureMapsTimezoneReadRole`, one per stack)
 * with exactly the data action `Microsoft.Maps/accounts/services/timezone/read`, on the
 * account only. The built-in **Azure Maps Data Reader** grants every Maps
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal and client secret (see
 * `AzureBindings`).
 * Provide {@link GetTimezoneIANAVersionHttp}.
 *
 * ### Calling GetTimezoneIANAVersion
 * **Example:** GetTimezoneIANAVersion from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsTimezoneReadRole on the account
 *     const getTimezoneIANAVersion = yield* Azure.Maps.GetTimezoneIANAVersion(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { version } = yield* getTimezoneIANAVersion({ format: "json" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetTimezoneIANAVersionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetTimezoneIANAVersion extends Binding.Service<
  GetTimezoneIANAVersion,
  "Azure.Maps.GetTimezoneIANAVersion",
  (account: Account) => Effect.Effect<GetTimezoneIANAVersionClient>
> {}

export const GetTimezoneIANAVersion = Binding.Service<GetTimezoneIANAVersion>(
  "Azure.Maps.GetTimezoneIANAVersion",
);
