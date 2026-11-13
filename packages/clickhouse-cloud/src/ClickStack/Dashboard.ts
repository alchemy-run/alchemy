import * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { OperationFailed, MissingId } from "../Errors.ts";
import type { Providers } from "../Providers.ts";
import { type ClickStackScope, covers } from "./internal.ts";

export type DashboardProps = ClickStackScope &
  Omit<stack.CreateClickStackDashboardRequest, "organizationId" | "serviceId">;

export interface DashboardAttributes {
  /** ID of the dashboard. */
  id: string;
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** The object as ClickStack stores it. */
  observed: stack.ClickStackDashboardResponse;
}

export type Dashboard = Resource<
  "ClickHouseCloud.ClickStack.Dashboard",
  DashboardProps,
  DashboardAttributes,
  never,
  Providers
>;

/**
 * A ClickStack dashboard: tiles of charts, tables and searches over
 * sources, with filters. Give each tile an `id` so alerts can point at it
 * across updates.
 *
 * ClickStack is in public beta and must be set up for the service in the
 * console before its API answers. Updates send the whole object (PUT), so
 * the props are the full definition. Deploy validates the dashboard before saving it, so a broken tile fails
 * the deploy with ClickStack's field errors. Dashboards have no
 * optimistic locking: edits made in the UI are overwritten by the next
 * deploy.
 * Objects in ClickStack carry no alchemy marker, so only those in state
 * are managed. Needs `control-plane:service:manage-clickstack-api`.
 * @see https://clickhouse.com/docs/use-cases/observability/clickstack
 *
 * ### Creating a Dashboard
 * **Example:** In the service's ClickStack
 * ```typescript
 * yield* ClickHouseCloud.ClickStack.Dashboard("Overview", {
 *   serviceId: analytics.serviceId,
 *   name: "Overview",
 *   tiles: [
 *     {
 *       id: "error-rate",
 *       x: 0,
 *       y: 0,
 *       w: 6,
 *       h: 4,
 *       config: { type: "line", sourceId: logs.id, select: [{ aggFn: "count" }], where: "SeverityText:error" },
 *     },
 *   ],
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the object.
 * :::
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `createClickStackDashboard`, `deleteClickStackDashboard`, `getClickStackDashboard`, `updateClickStackDashboard`, `validateClickStackDashboard`.
 *
 * @resource
 * @product ClickStack
 */
export const Dashboard = Resource<Dashboard>("ClickHouseCloud.ClickStack.Dashboard");

const getDashboard = (organizationId: string, serviceId: string, id: string) =>
  stack.getClickStackDashboard({ organizationId, serviceId, clickStackDashboardId: id }).pipe(
    Effect.map((found): stack.ClickStackDashboardResponse | undefined => found),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const DashboardProvider = () =>
  Provider.effect(
    Dashboard,
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
        const found = yield* getDashboard(output.organizationId, output.serviceId, output.id);
        return found === undefined ? undefined : { ...output, observed: found };
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        const body = (({ serviceId: _, ...rest }) => rest)(news);
        // Observe
        const observed = output?.id
          ? yield* getDashboard(organizationId, serviceId, output.id)
          : undefined;
        if (observed !== undefined && output !== undefined && covers(observed, body)) {
          return { id: output.id, serviceId, organizationId, observed };
        }
        // Validate first: ClickStack answers with field errors instead of a rejected write.
        const validation = yield* stack.validateClickStackDashboard({
          organizationId,
          serviceId,
          ...body,
        });
        if (!validation.valid) {
          return yield* new OperationFailed({
            kind: "ClickStack dashboard",
            id: String(body.name),
            state: "invalid",
            detail: JSON.stringify(validation.errors),
          });
        }
        // Ensure or sync: a PUT carries the whole object.
        const saved =
          observed === undefined
            ? yield* stack.createClickStackDashboard({ organizationId, serviceId, ...body })
            : yield* ((id: string) =>
                stack.updateClickStackDashboard({
                  organizationId,
                  serviceId,
                  clickStackDashboardId: id,
                  // Update filters carry IDs; give each filter an `id` to keep it across updates.
                  ...(body as Omit<
                    stack.UpdateClickStackDashboardRequest,
                    "organizationId" | "serviceId" | "clickStackDashboardId"
                  >),
                }))(observed.id!);
        if (saved.id === undefined) {
          return yield* new MissingId({ operation: "createClickStackDashboard" });
        }
        return { id: saved.id, serviceId, organizationId, observed: saved };
      }),
      delete: Effect.fn(function* ({ output }) {
        const { organizationId, serviceId, id } = output;
        yield* stack
          .deleteClickStackDashboard({ organizationId, serviceId, clickStackDashboardId: id })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
