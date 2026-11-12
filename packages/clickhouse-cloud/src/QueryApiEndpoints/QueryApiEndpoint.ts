import * as qae from "@distilled.cloud/clickhouse-cloud/query_api_endpoints";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { QueryApiEndpointUserOwned, requireResult } from "../Errors.ts";
import { isOwnedName, resolveName } from "../internal/Names.ts";
import type { Providers } from "../Providers.ts";

export interface QueryApiEndpointProps {
  /** ID of the service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the endpoint. */
  serviceId: string;
  /**
   * Endpoint name. If omitted, a unique name is generated from the stack,
   * stage and logical ID. Changing it renames the endpoint in place.
   */
  name?: string;
  /** The SQL the endpoint runs; `{name:Type}` placeholders become query variables. */
  sql: string;
  /** Database the SQL runs in. */
  database: string;
  /** Default values of the query variables. */
  parameters?: Record<string, string>;
  /**
   * IDs of the organization API keys allowed to call the endpoint (the
   * `id` attribute of `ClickHouseCloud.ApiKeys.ApiKey`). Hosts bound with
   * `RunQueryApiEndpoint` add their own key.
   * @default []
   */
  apiKeyIds?: string[];
  /** Database roles the SQL runs as, e.g. `["default_role"]` (the role every service has). */
  roles: string[];
  /** Origins allowed to call the endpoint from a browser (CORS). */
  allowedOrigins?: string[];
}

export interface QueryApiEndpointAttributes {
  /** Endpoint ID. */
  endpointId: string;
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Endpoint name. */
  name: string;
  /** URL that runs the endpoint (`POST`, Basic auth with an allowed key). */
  url: string;
  /** The SQL. */
  sql: string;
  /** Database. */
  database: string;
  /** Default query variables. */
  parameters: Record<string, string>;
  /** API keys allowed to call the endpoint, including bound hosts' keys. */
  apiKeyIds: string[];
  /** Database roles. */
  roles: string[];
  /** CORS origins. */
  allowedOrigins: string[];
}

/** What a binding adds to the endpoint: the API keys of the hosts that run it. */
export interface QueryApiEndpointBinding {
  apiKeyIds: string[];
}

export type QueryApiEndpoint = Resource<
  "ClickHouseCloud.QueryApiEndpoints.QueryApiEndpoint",
  QueryApiEndpointProps,
  QueryApiEndpointAttributes,
  QueryApiEndpointBinding,
  Providers
>;

/**
 * A Query API endpoint: one SQL statement on a service exposed at its own
 * URL, run with an allowed organization API key, its `{name:Type}`
 * placeholders filled from the request. A way to serve a fixed query to an
 * app without giving it database credentials.
 *
 * Every prop but the service updates the endpoint in place. Hosts bound
 * with `ClickHouseCloud.QueryApiEndpoints.RunQueryApiEndpoint` add their
 * key to `apiKeyIds` on deploy. Endpoints created in the console run a
 * query a console user owns; the API refuses to change them and so does
 * this resource (`QueryApiEndpointUserOwned`). Endpoints have no tags, so
 * a generated name is the ownership marker.
 * @see https://clickhouse.com/docs/cloud/get-started/query-endpoints
 *
 * ### Creating an Endpoint
 * **Example:** Top pages of a day, callable by one key
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * const role = yield* ClickHouseCloud.RoleManagement.Role("TopPagesCaller", {
 *   policies: [
 *     {
 *       allowDeny: "ALLOW",
 *       permissions: ["control-plane:service:view-query-api-endpoints"],
 *       resources: [Output.interpolate`instance/${analytics.serviceId}`],
 *     },
 *   ],
 * });
 * const key = yield* ClickHouseCloud.ApiKeys.ApiKey("TopPagesKey", {
 *   assignedRoleIds: [role.roleId],
 * });
 * const endpoint = yield* ClickHouseCloud.QueryApiEndpoints.QueryApiEndpoint("TopPages", {
 *   serviceId: analytics.serviceId,
 *   database: "default",
 *   sql: "SELECT path, count() AS hits FROM events WHERE day = {day:Date} GROUP BY path ORDER BY hits DESC LIMIT 10",
 *   roles: ["default_role"],
 *   apiKeyIds: [key.id],
 * });
 * // POST endpoint.url?format=JSONEachRow with {"queryVariables":{"day":"2026-11-01"}}
 * ```
 *
 * ### Running it from a Worker
 * **Example:** Bind the endpoint; the host's key is allowed on deploy
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const run = yield* ClickHouseCloud.QueryApiEndpoints.RunQueryApiEndpoint(TopPages);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const rows = yield* run({ queryVariables: { day: "2026-11-01" } });
 *         return yield* HttpServerResponse.json(rows);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.QueryApiEndpoints.RunQueryApiEndpointHttp)),
 * ) {}
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the endpoint, and its URL changes.
 * :::
 *
 * @resource
 * @product Query API Endpoint
 */
export const QueryApiEndpoint = Resource<QueryApiEndpoint>(
  "ClickHouseCloud.QueryApiEndpoints.QueryApiEndpoint",
);

const clean = (map: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(map ?? {}).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
  ) as Record<string, string>;

const toAttributes = (
  organizationId: string,
  serviceId: string,
  endpoint: qae.PublicQueryApiEndpoint,
): QueryApiEndpointAttributes => ({
  endpointId: endpoint.id,
  serviceId,
  organizationId,
  name: endpoint.name,
  url: endpoint.url,
  sql: endpoint.sql,
  database: endpoint.database,
  parameters: clean(endpoint.parameters),
  apiKeyIds: [...endpoint.apiKeyIds],
  roles: [...endpoint.roles],
  allowedOrigins: [...endpoint.allowedOrigins],
});

const sorted = (values: readonly string[]) => [...values].sort();

const getEndpoint = (organizationId: string, serviceId: string, endpointId: string) =>
  qae.getQueryApiEndpoint({ organizationId, serviceId, endpointId }).pipe(
    Effect.flatMap(requireResult("getQueryApiEndpoint")),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const findByName = (organizationId: string, serviceId: string, name: string) =>
  qae.listQueryApiEndpoints.items({ organizationId, serviceId }).pipe(
    Stream.filter((e) => e.name === name),
    Stream.runHead,
    Effect.flatMap((found) =>
      found._tag === "Some"
        ? getEndpoint(organizationId, serviceId, found.value.id)
        : Effect.undefined,
    ),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const QueryApiEndpointProvider = () =>
  Provider.effect(
    QueryApiEndpoint,
    Effect.succeed({
      stables: ["endpointId", "serviceId", "organizationId"],
      nuke: { dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const name = yield* resolveName(id, olds?.name, output?.name);
        const observed = output?.endpointId
          ? yield* getEndpoint(organizationId, serviceId, output.endpointId)
          : yield* findByName(organizationId, serviceId, name);
        if (observed === undefined) return undefined;
        const attrs = toAttributes(organizationId, serviceId, observed);
        const owned =
          observed.ownerType !== "user" &&
          (yield* isOwnedName(
            id,
            attrs.name,
            output !== undefined || attrs.endpointId === previous?.endpointId,
          ));
        return owned ? attrs : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        const name = yield* resolveName(id, news.name, output?.name);
        // Desired: the declared keys plus every bound host's key.
        const apiKeyIds = [
          ...new Set([
            ...(news.apiKeyIds ?? []),
            ...(bindings as ResourceBinding<QueryApiEndpointBinding>[]).flatMap(
              (b) => b.data.apiKeyIds,
            ),
          ]),
        ];
        const body = {
          name,
          sql: news.sql,
          database: news.database,
          parameters: news.parameters ?? {},
          apiKeyIds,
          roles: news.roles,
          allowedOrigins: news.allowedOrigins ?? [],
        };
        // Observe
        const observed = output?.endpointId
          ? yield* getEndpoint(organizationId, serviceId, output.endpointId)
          : yield* findByName(organizationId, serviceId, name);
        // Ensure
        if (observed === undefined) {
          const created = yield* qae
            .createQueryApiEndpoint({ organizationId, serviceId, ...body })
            .pipe(Effect.flatMap(requireResult("createQueryApiEndpoint")));
          return toAttributes(organizationId, serviceId, created);
        }
        if (observed.ownerType === "user") {
          return yield* new QueryApiEndpointUserOwned({ endpointId: observed.id });
        }
        // Sync: a PUT carrying the whole endpoint.
        const attrs = toAttributes(organizationId, serviceId, observed);
        if (
          attrs.name === body.name &&
          attrs.sql === body.sql &&
          attrs.database === body.database &&
          deepEqual(attrs.parameters, body.parameters) &&
          deepEqual(sorted(attrs.apiKeyIds), sorted(body.apiKeyIds)) &&
          deepEqual(sorted(attrs.roles), sorted(body.roles)) &&
          deepEqual(sorted(attrs.allowedOrigins), sorted(body.allowedOrigins))
        ) {
          return attrs;
        }
        const updated = yield* qae
          .updateQueryApiEndpoint({ organizationId, serviceId, endpointId: observed.id, ...body })
          .pipe(Effect.flatMap(requireResult("updateQueryApiEndpoint")));
        return toAttributes(organizationId, serviceId, updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* qae
          .deleteQueryApiEndpoint({
            organizationId: output.organizationId,
            serviceId: output.serviceId,
            endpointId: output.endpointId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
