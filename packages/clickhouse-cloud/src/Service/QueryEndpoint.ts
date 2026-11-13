import * as service from "@distilled.cloud/clickhouse-cloud/service";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import type { Providers } from "../Providers.ts";

/** A SQL console role the endpoint runs queries as. */
export type QueryEndpointRole = "sql_console_read_only" | "sql_console_admin";

export interface QueryEndpointProps {
  /** ID of the service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the resource. */
  serviceId: string;
  /** Roles queries through the endpoint may run as. */
  roles: QueryEndpointRole[];
  /**
   * IDs of the organization API keys allowed to call the endpoint: the
   * `id` attribute of `ClickHouseCloud.ApiKeys.ApiKey` resources.
   */
  apiKeyIds: string[];
  /** Origins allowed to call the endpoint from a browser (CORS). Omit for none. */
  allowedOrigins?: string[];
}

export interface QueryEndpointAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Endpoint ID. */
  endpointId: string;
  /** Roles queries may run as. */
  roles: string[];
  /** API keys allowed to call the endpoint. */
  apiKeyIds: string[];
  /** Origins allowed to call the endpoint. */
  allowedOrigins: string[];
}

export type QueryEndpoint = Resource<
  "ClickHouseCloud.Service.QueryEndpoint",
  QueryEndpointProps,
  QueryEndpointAttributes,
  never,
  Providers
>;

/**
 * The query endpoint of a service: lets the listed organization API keys
 * run SQL against the service over HTTPS as one of the SQL console roles,
 * without a database password.
 *
 * A service has one query endpoint; every prop updates it in place, and
 * destroying the resource switches it off.
 * @see https://clickhouse.com/docs/cloud/get-started/query-endpoints
 *
 * ### Enabling the Query Endpoint
 * **Example:** Read-only queries for one key
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * const reader = yield* ClickHouseCloud.RoleManagement.Role("QueryReader", {
 *   policies: [
 *     {
 *       allowDeny: "ALLOW",
 *       permissions: ["control-plane:service:view"],
 *       resources: [Output.interpolate`instance/${analytics.serviceId}`],
 *     },
 *   ],
 * });
 * const key = yield* ClickHouseCloud.ApiKeys.ApiKey("Dashboards", {
 *   assignedRoleIds: [reader.roleId],
 * });
 * yield* ClickHouseCloud.Service.QueryEndpoint("AnalyticsQueries", {
 *   serviceId: analytics.serviceId,
 *   roles: ["sql_console_read_only"],
 *   apiKeyIds: [key.id],
 *   allowedOrigins: ["https://dashboards.example.com"],
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the resource: the old service's endpoint
 * is switched off.
 * :::
 *
 * @resource
 * @product Service
 */
export const QueryEndpoint = Resource<QueryEndpoint>("ClickHouseCloud.Service.QueryEndpoint");

const splitOrigins = (origins: string | undefined) =>
  (origins ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

const toAttributes = (
  organizationId: string,
  serviceId: string,
  endpoint: service.ServiceQueryAPIEndpoint,
): QueryEndpointAttributes => ({
  serviceId,
  organizationId,
  endpointId: endpoint.id ?? "",
  roles: [...(endpoint.roles ?? [])],
  apiKeyIds: [...(endpoint.openApiKeys ?? [])],
  allowedOrigins: splitOrigins(endpoint.allowedOrigins),
});

const getEndpoint = (organizationId: string, serviceId: string) =>
  service.getServiceQueryEndpoint({ organizationId, serviceId }).pipe(
    // No endpoint, or no service.
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const sameSet = (a: readonly string[], b: readonly string[]) =>
  deepEqual([...a].sort(), [...b].sort());

export const QueryEndpointProvider = () =>
  Provider.effect(
    QueryEndpoint,
    Effect.succeed({
      stables: ["serviceId", "organizationId"],
      nuke: { singleton: true, dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const endpoint = yield* getEndpoint(organizationId, serviceId);
        return endpoint === undefined
          ? undefined
          : toAttributes(organizationId, serviceId, endpoint);
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        // Observe
        const observed = yield* getEndpoint(organizationId, serviceId);
        if (observed !== undefined) {
          const attrs = toAttributes(organizationId, serviceId, observed);
          if (
            sameSet(attrs.roles, news.roles) &&
            sameSet(attrs.apiKeyIds, news.apiKeyIds) &&
            sameSet(attrs.allowedOrigins, news.allowedOrigins ?? [])
          ) {
            return attrs;
          }
        }
        // Ensure + sync: upsert sends the whole endpoint.
        const updated = yield* service.upsertServiceQueryEndpoint({
          organizationId,
          serviceId,
          roles: news.roles,
          openApiKeys: news.apiKeyIds,
          allowedOrigins: (news.allowedOrigins ?? []).join(","),
        });
        return toAttributes(organizationId, serviceId, updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* service
          .deleteServiceQueryEndpoint({
            organizationId: output.organizationId,
            serviceId: output.serviceId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
