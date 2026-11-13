import * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { FeatureUnavailable } from "../Errors.ts";
import type { Providers } from "../Providers.ts";
import { type ClickStackScope, covers } from "./internal.ts";

export type RoleProps = ClickStackScope &
  Omit<stack.CreateClickStackRoleRequest, "organizationId" | "serviceId">;

export interface RoleAttributes {
  /** ID of the role. */
  id: string;
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** The object as ClickStack stores it. */
  observed: stack.ClickStackRole;
}

export type Role = Resource<
  "ClickHouseCloud.ClickStack.Role",
  RoleProps,
  RoleAttributes,
  never,
  Providers
>;

/**
 * A custom ClickStack team role: CASL permissions (`action`, `subject`,
 * optional `fields` and `conditions`) over ClickStack and ClickHouse
 * objects.
 *
 * ClickStack is in public beta and must be set up for the service in the
 * console before its API answers. Updates send the whole object (PUT), so
 * the props are the full definition. Predefined roles are never changed (`PredefinedRoleImmutable`). The
 * API can't assign roles to users: assign them in the ClickStack UI.
 * Objects in ClickStack carry no alchemy marker, so only those in state
 * are managed. Needs `control-plane:service:manage-clickstack-api`.
 * @see https://clickhouse.com/docs/use-cases/observability/clickstack
 *
 * ### Creating a Role
 * **Example:** In the service's ClickStack
 * ```typescript
 * yield* ClickHouseCloud.ClickStack.Role("Viewers", {
 *   serviceId: analytics.serviceId,
 *   name: "viewers",
 *   description: "read dashboards and searches",
 *   permissions: [{ action: "read", subject: "Dashboard", integration: "mongodb" }, { action: "read", subject: "SavedSearch", integration: "mongodb" }],
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the object.
 * :::
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `createClickStackRole`, `deleteClickStackRole`, `getClickStackRole`, `updateClickStackRole`.
 *
 * @resource
 * @product ClickStack
 */
export const Role = Resource<Role>("ClickHouseCloud.ClickStack.Role");

const getRole = (organizationId: string, serviceId: string, id: string) =>
  stack.getClickStackRole({ organizationId, serviceId, clickStackRoleId: id }).pipe(
    Effect.map((found): stack.ClickStackRole | undefined => found),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const RoleProvider = () =>
  Provider.effect(
    Role,
    Effect.succeed({
      stables: ["id", "serviceId", "organizationId"],
      nuke: { dependsOn: [] },
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
        const found = yield* getRole(output.organizationId, output.serviceId, output.id);
        return found === undefined ? undefined : { ...output, observed: found };
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        const body = (({ serviceId: _, ...rest }) => rest)(news);
        // Observe
        const observed = output?.id
          ? yield* getRole(organizationId, serviceId, output.id)
          : undefined;
        if (observed?.isPredefined) {
          return yield* new FeatureUnavailable({
            feature: "ClickStack role",
            reason: `"${observed.name}" is a predefined role and cannot be changed`,
          });
        }
        if (observed !== undefined && output !== undefined && covers(observed, body)) {
          return { id: output.id, serviceId, organizationId, observed };
        }
        // Ensure or sync: a PUT carries the whole object.
        const saved =
          observed === undefined
            ? yield* stack.createClickStackRole({ organizationId, serviceId, ...body })
            : yield* ((id: string) =>
                stack.updateClickStackRole({
                  organizationId,
                  serviceId,
                  clickStackRoleId: id,
                  ...body,
                }))(observed.id!);
        return { id: saved.id, serviceId, organizationId, observed: saved };
      }),
      delete: Effect.fn(function* ({ output }) {
        const { organizationId, serviceId, id } = output;
        yield* stack
          .deleteClickStackRole({ organizationId, serviceId, clickStackRoleId: id })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
