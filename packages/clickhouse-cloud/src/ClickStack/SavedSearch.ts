import * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { ResultMissing, requireResult } from "../Errors.ts";
import type { Providers } from "../Providers.ts";
import { type ClickStackScope, covers } from "./internal.ts";

export type SavedSearchProps = ClickStackScope &
  Omit<stack.CreateClickStackSavedSearchRequest, "organizationId" | "serviceId">;

export interface SavedSearchAttributes {
  /** ID of the saved search. */
  id: string;
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** The object as ClickStack stores it. */
  observed: stack.ClickStackSavedSearch;
}

export type SavedSearch = Resource<
  "ClickHouseCloud.ClickStack.SavedSearch",
  SavedSearchProps,
  SavedSearchAttributes,
  never,
  Providers
>;

/**
 * A saved ClickStack search: a query (Lucene or SQL) over a source, with
 * the columns, ordering and filters to show. Alerts can watch it.
 *
 * ClickStack is in public beta and must be set up for the service in the
 * console before its API answers. Updates send the whole object (PUT), so
 * the props are the full definition. Deleting a saved search also deletes the alerts attached to it.
 * Objects in ClickStack carry no alchemy marker, so only those in state
 * are managed. Needs `control-plane:service:manage-clickstack-api`.
 * @see https://clickhouse.com/docs/use-cases/observability/clickstack
 *
 * ### Creating a Saved Search
 * **Example:** In the service's ClickStack
 * ```typescript
 * yield* ClickHouseCloud.ClickStack.SavedSearch("Errors", {
 *   serviceId: analytics.serviceId,
 *   name: "Errors",
 *   sourceId: logs.id,
 *   where: "SeverityText:error",
 *   whereLanguage: "lucene",
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the object.
 * :::
 *
 * @resource
 * @product ClickStack
 */
export const SavedSearch = Resource<SavedSearch>("ClickHouseCloud.ClickStack.SavedSearch");

const getSavedSearch = (organizationId: string, serviceId: string, id: string) =>
  stack.getClickStackSavedSearch({ organizationId, serviceId, clickStackSavedSearchId: id }).pipe(
    Effect.flatMap(requireResult("getSavedSearch")),
    Effect.map((found): stack.ClickStackSavedSearch | undefined => found),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const SavedSearchProvider = () =>
  Provider.effect(
    SavedSearch,
    Effect.succeed({
      stables: ["id", "serviceId", "organizationId"],
      nuke: { dependsOn: ["ClickHouseCloud.ClickStack.Alert"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ output }) {
        if (output === undefined) return undefined;
        const found = yield* getSavedSearch(output.organizationId, output.serviceId, output.id);
        return found === undefined ? undefined : { ...output, observed: found };
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        const body = (({ serviceId: _, ...rest }) => rest)(news);
        // Observe
        const observed = output?.id
          ? yield* getSavedSearch(organizationId, serviceId, output.id)
          : undefined;
        if (observed !== undefined && output !== undefined && covers(observed, body)) {
          return { id: output.id, serviceId, organizationId, observed };
        }
        // Ensure or sync: a PUT carries the whole object.
        const saved =
          observed === undefined
            ? yield* stack
                .createClickStackSavedSearch({ organizationId, serviceId, ...body })
                .pipe(Effect.flatMap(requireResult("createSavedSearch")))
            : yield* ((id: string) =>
                stack.updateClickStackSavedSearch({
                  organizationId,
                  serviceId,
                  clickStackSavedSearchId: id,
                  ...body,
                }))(observed.id!).pipe(Effect.flatMap(requireResult("updateSavedSearch")));
        if (saved.id === undefined)
          return yield* new ResultMissing({ operation: "createSavedSearch (id)" });
        return { id: saved.id, serviceId, organizationId, observed: saved };
      }),
      delete: Effect.fn(function* ({ output }) {
        const { organizationId, serviceId, id } = output;
        yield* stack
          .deleteClickStackSavedSearch({ organizationId, serviceId, clickStackSavedSearchId: id })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
