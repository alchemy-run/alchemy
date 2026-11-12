import * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { ResultMissing, requireResult } from "../Errors.ts";
import type { Providers } from "../Providers.ts";
import { type ClickStackScope, covers } from "./internal.ts";

export type SourceProps = ClickStackScope & {
  /**
   * The source: `kind` (`log`, `trace`, `metric`, `session` or
   * `promql`), `name`, the ClickStack `connection` ID, the table it reads
   * (`from`) and the expressions mapping its columns. Changing `kind`
   * replaces the source; everything else updates in place.
   */
  source: stack.ClickStackSource;
};

export interface SourceAttributes {
  /** ID of the source. */
  id: string;
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** The object as ClickStack stores it. */
  observed: stack.ClickStackSource;
}

export type Source = Resource<
  "ClickHouseCloud.ClickStack.Source",
  SourceProps,
  SourceAttributes,
  never,
  Providers
>;

/**
 * A ClickStack data source: which table of the service holds logs, traces,
 * metrics or sessions, and which columns carry the timestamp, body,
 * severity, service name and so on, so ClickStack can search and chart it.
 *
 * ClickStack is in public beta and must be set up for the service in the
 * console before its API answers. Updates send the whole object (PUT), so
 * the props are the full definition. The `connection` is the ID of a ClickStack connection, which the API
 * can't create or list: copy it from the ClickStack UI.
 * Objects in ClickStack carry no alchemy marker, so only those in state
 * are managed. Needs `control-plane:service:manage-clickstack-api`.
 * @see https://clickhouse.com/docs/use-cases/observability/clickstack
 *
 * ### Creating a Source
 * **Example:** In the service's ClickStack
 * ```typescript
 * const logs = yield* ClickHouseCloud.ClickStack.Source("Logs", {
 *   serviceId: analytics.serviceId,
 *   source: {
 *     kind: "log",
 *     name: "Logs",
 *     connection: "<ClickStack connection id>",
 *     from: { databaseName: "otel", tableName: "otel_logs" },
 *     timestampValueExpression: "TimestampTime",
 *     defaultTableSelectExpression: "Timestamp, ServiceName, SeverityText, Body",
 *     serviceNameExpression: "ServiceName",
 *     severityTextExpression: "SeverityText",
 *     bodyExpression: "Body",
 *   },
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` or the source `kind` replaces the object.
 * :::
 *
 * @resource
 * @product ClickStack
 */
export const Source = Resource<Source>("ClickHouseCloud.ClickStack.Source");

const getSource = (organizationId: string, serviceId: string, id: string) =>
  stack.getClickStackSource({ organizationId, serviceId, clickStackSourceId: id }).pipe(
    Effect.flatMap(requireResult("getSource")),
    Effect.map((found): stack.ClickStackSource | undefined => found),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const SourceProvider = () =>
  Provider.effect(
    Source,
    Effect.succeed({
      stables: ["id", "serviceId", "organizationId"],
      nuke: {
        dependsOn: [
          "ClickHouseCloud.ClickStack.SavedSearch",
          "ClickHouseCloud.ClickStack.Dashboard",
        ],
      },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId || news.source.kind !== olds.source.kind) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ output }) {
        if (output === undefined) return undefined;
        const found = yield* getSource(output.organizationId, output.serviceId, output.id);
        return found === undefined ? undefined : { ...output, observed: found };
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        const body = news.source;
        // Observe
        const observed = output?.id
          ? yield* getSource(organizationId, serviceId, output.id)
          : undefined;
        if (observed !== undefined && output !== undefined && covers(observed, body)) {
          return { id: output.id, serviceId, organizationId, observed };
        }
        // Ensure or sync: a PUT carries the whole object.
        const saved =
          observed === undefined
            ? yield* stack
                .createClickStackSource({ organizationId, serviceId, body })
                .pipe(Effect.flatMap(requireResult("createSource")))
            : yield* ((id: string) =>
                stack.updateClickStackSource({
                  organizationId,
                  serviceId,
                  clickStackSourceId: id,
                  body,
                }))(observed.id!).pipe(Effect.flatMap(requireResult("updateSource")));
        if (saved.id === undefined)
          return yield* new ResultMissing({ operation: "createSource (id)" });
        return { id: saved.id, serviceId, organizationId, observed: saved };
      }),
      delete: Effect.fn(function* ({ output }) {
        const { organizationId, serviceId, id } = output;
        yield* stack
          .deleteClickStackSource({ organizationId, serviceId, clickStackSourceId: id })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
