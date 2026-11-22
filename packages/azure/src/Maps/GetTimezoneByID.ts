import type * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetTimezoneByID` request; the bound account supplies `x-ms-client-id`. */
export interface GetTimezoneByIDRequest extends Omit<
  timezone.GetTimezoneTimezoneByIDRequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetTimezoneByID}. */
export type GetTimezoneByIDClient = (
  request: GetTimezoneByIDRequest,
) => Effect.Effect<timezone.TimezoneResult, timezone.GetTimezoneTimezoneByIDError, RuntimeContext>;

/**
 * Get a time zone by its IANA ID. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetTimezoneByIDHttp}.
 *
 * ### Calling GetTimezoneByID
 * **Example:** GetTimezoneByID from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsTimezoneReadRole on the account
 *     const getTimezoneByID = yield* Azure.Maps.GetTimezoneByID(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const { timeZones } = yield* getTimezoneByID({ format: "json", query: "America/Los_Angeles" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetTimezoneByIDHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetTimezoneByID extends Binding.Service<
  GetTimezoneByID,
  "Azure.Maps.GetTimezoneByID",
  (account: Account) => Effect.Effect<GetTimezoneByIDClient>
> {}

export const GetTimezoneByID = Binding.Service<GetTimezoneByID>("Azure.Maps.GetTimezoneByID");
