import * as saved from "@distilled.cloud/clickhouse-cloud/saved_queries";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { requireResult } from "../Errors.ts";
import { isOwnedName, resolveName } from "../internal/Names.ts";
import type { Providers } from "../Providers.ts";

export interface SavedQueryProps {
  /** ID of the service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the query. */
  serviceId: string;
  /**
   * Name in the SQL console. If omitted, a unique name is generated from
   * the stack, stage and logical ID. Changing it renames the query in place.
   */
  name?: string;
  /** The SQL. */
  sql: string;
  /** Database the query runs in. */
  database: string;
  /** Default values of the query's `{name:Type}` parameters. */
  parameters?: Record<string, string>;
}

export interface SavedQueryAttributes {
  /** Saved query ID. */
  queryId: string;
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Name. */
  name: string;
  /** The SQL. */
  sql: string;
  /** Database. */
  database: string;
  /** Default parameter values. */
  parameters: Record<string, string>;
}

export type SavedQuery = Resource<
  "ClickHouseCloud.SavedQueries.SavedQuery",
  SavedQueryProps,
  SavedQueryAttributes,
  never,
  Providers
>;

/**
 * A query saved in a service's SQL console, shared with everyone who can
 * open the console: a name, the SQL, the database it runs in and default
 * values for its parameters.
 *
 * Every prop but the service updates the query in place. Saved queries
 * have no tags, so a generated name is the ownership marker.
 * @see https://clickhouse.com/docs/cloud/get-started/sql-console
 *
 * ### Saving a Query
 * **Example:** A parameterised report
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.SavedQueries.SavedQuery("TopPages", {
 *   serviceId: analytics.serviceId,
 *   name: "Top pages",
 *   database: "default",
 *   sql: "SELECT path, count() AS hits FROM events WHERE day = {day:Date} GROUP BY path ORDER BY hits DESC LIMIT 10",
 *   parameters: { day: "2026-11-01" },
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the query: it is deleted from the old
 * service's console.
 * :::
 *
 * @resource
 * @product Saved Query
 */
export const SavedQuery = Resource<SavedQuery>("ClickHouseCloud.SavedQueries.SavedQuery");

const cleanParameters = (parameters: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(parameters ?? {}).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
  ) as Record<string, string>;

const toAttributes = (
  organizationId: string,
  serviceId: string,
  query: saved.PublicSavedQuery,
): SavedQueryAttributes => ({
  queryId: query.id,
  serviceId,
  organizationId,
  name: query.name,
  sql: query.sql,
  database: query.database,
  parameters: cleanParameters(query.parameters),
});

const getQuery = (organizationId: string, serviceId: string, queryId: string) =>
  saved.getSavedQuery({ organizationId, serviceId, queryId }).pipe(
    Effect.flatMap(requireResult("getSavedQuery")),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const findByName = (organizationId: string, serviceId: string, name: string) =>
  saved.listSavedQueries.items({ organizationId, serviceId }).pipe(
    Stream.filter((q) => q.name === name),
    Stream.runHead,
    Effect.flatMap((found) =>
      found._tag === "Some"
        ? getQuery(organizationId, serviceId, found.value.id)
        : Effect.undefined,
    ),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const SavedQueryProvider = () =>
  Provider.effect(
    SavedQuery,
    Effect.succeed({
      stables: ["queryId", "serviceId", "organizationId"],
      // Listed per service only: deleting the services removes them.
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
        const observed = output?.queryId
          ? yield* getQuery(organizationId, serviceId, output.queryId)
          : yield* findByName(organizationId, serviceId, name);
        if (observed === undefined) return undefined;
        const attrs = toAttributes(organizationId, serviceId, observed);
        return (yield* isOwnedName(
          id,
          attrs.name,
          output !== undefined || attrs.queryId === previous?.queryId,
        ))
          ? attrs
          : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        const name = yield* resolveName(id, news.name, output?.name);
        const body = {
          name,
          sql: news.sql,
          database: news.database,
          parameters: news.parameters ?? {},
        };
        // Observe
        const observed = output?.queryId
          ? yield* getQuery(organizationId, serviceId, output.queryId)
          : yield* findByName(organizationId, serviceId, name);
        // Ensure
        if (observed === undefined) {
          const created = yield* saved
            .createSavedQuery({ organizationId, serviceId, ...body })
            .pipe(Effect.flatMap(requireResult("createSavedQuery")));
          return toAttributes(organizationId, serviceId, created);
        }
        // Sync: a PUT carrying the whole query.
        const attrs = toAttributes(organizationId, serviceId, observed);
        if (
          attrs.name === body.name &&
          attrs.sql === body.sql &&
          attrs.database === body.database &&
          deepEqual(attrs.parameters, body.parameters)
        ) {
          return attrs;
        }
        const updated = yield* saved
          .updateSavedQuery({ organizationId, serviceId, queryId: observed.id, ...body })
          .pipe(Effect.flatMap(requireResult("updateSavedQuery")));
        return toAttributes(organizationId, serviceId, updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* saved
          .deleteSavedQuery({
            organizationId: output.organizationId,
            serviceId: output.serviceId,
            queryId: output.queryId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
