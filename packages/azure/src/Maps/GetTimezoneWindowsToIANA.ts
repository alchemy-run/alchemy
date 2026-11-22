import type * as timezone from "@distilled.cloud/azure/maps-timezone";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

/** A `GetTimezoneWindowsToIANA` request; the bound account supplies `x-ms-client-id`. */
export interface GetTimezoneWindowsToIANARequest extends Omit<
  timezone.GetTimezoneTimezoneWindowsToIANARequest,
  "xMsClientId"
> {}

/** Runtime callable of {@link GetTimezoneWindowsToIANA}. */
export type GetTimezoneWindowsToIANAClient = (
  request: GetTimezoneWindowsToIANARequest,
) => Effect.Effect<
  timezone.GetTimezoneTimezoneWindowsToIANAResponse,
  timezone.GetTimezoneTimezoneWindowsToIANAError,
  RuntimeContext
>;

/**
 * Convert a Windows time zone ID to IANA IDs. Calls Azure Maps from any host with Microsoft Entra ID,
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
 * Provide {@link GetTimezoneWindowsToIANAHttp}.
 *
 * ### Calling GetTimezoneWindowsToIANA
 * **Example:** GetTimezoneWindowsToIANA from a Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Maps.Account("maps");
 *     // init: assigns AzureMapsTimezoneReadRole on the account
 *     const getTimezoneWindowsToIANA = yield* Azure.Maps.GetTimezoneWindowsToIANA(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: x-ms-client-id is filled in
 *         const ids = yield* getTimezoneWindowsToIANA({ format: "json", query: "Pacific Standard Time" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Maps.GetTimezoneWindowsToIANAHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Maps
 */
export interface GetTimezoneWindowsToIANA extends Binding.Service<
  GetTimezoneWindowsToIANA,
  "Azure.Maps.GetTimezoneWindowsToIANA",
  (account: Account) => Effect.Effect<GetTimezoneWindowsToIANAClient>
> {}

export const GetTimezoneWindowsToIANA = Binding.Service<GetTimezoneWindowsToIANA>(
  "Azure.Maps.GetTimezoneWindowsToIANA",
);
