import type * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Namespace } from "./Namespace.ts";

/** A `ListSchemaGroups` request; the bound namespace supplies the endpoint. */
export interface ListSchemaGroupsRequest extends Omit<
  registry.ListSchemaGroupsRequest,
  "fullyQualifiedNamespace"
> {}

/** Runtime callable of {@link ListSchemaGroups}. */
export type ListSchemaGroupsClient = (
  request?: ListSchemaGroupsRequest,
) => Effect.Effect<registry.SchemaGroups, registry.ListSchemaGroupsError, RuntimeContext>;

/**
 * List the names of the schema groups in an Event Hubs namespace's schema
 * registry, one page at a time (pass the previous page's `NextLink` as
 * `nextLink`).
 *
 * Binding assigns **Schema Registry Reader** (data action
 * `Microsoft.EventHub/namespaces/schemas/read`) on the namespace, because
 * the list covers every group in it; bind a single group's schema bindings
 * when that is all a host needs. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`). Provide
 * {@link ListSchemaGroupsHttp}.
 *
 * ### Listing Schema Groups
 * **Example:** List the groups of a namespace
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the role on the namespace
 *     const listGroups = yield* Azure.EventHub.ListSchemaGroups(namespace);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the namespace endpoint is filled in
 *         const { Value: groups } = yield* listGroups();
 *         return yield* HttpServerResponse.json({ groups });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.ListSchemaGroupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface ListSchemaGroups extends Binding.Service<
  ListSchemaGroups,
  "Azure.EventHub.ListSchemaGroups",
  (namespace: Namespace) => Effect.Effect<ListSchemaGroupsClient>
> {}

export const ListSchemaGroups = Binding.Service<ListSchemaGroups>(
  "Azure.EventHub.ListSchemaGroups",
);
