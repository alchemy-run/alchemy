import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  POSTGRES_NAMESPACE,
  serverOnly,
  serverOwnedByStack,
  type ServerRef,
  whileServerBusy,
} from "./common.ts";

export type AdministratorPrincipalType = "User" | "Group" | "ServicePrincipal";

export interface AdministratorProps {
  /** Resource group of the server. Changing it replaces the administrator. */
  resourceGroup: string;
  /**
   * Name of the flexible server. The server must have Microsoft Entra
   * authentication enabled (`authConfig.activeDirectoryAuth: "Enabled"`).
   * Changing it replaces the administrator.
   */
  server: string;
  /**
   * Object ID of the Microsoft Entra user, group, or service principal.
   * Changing it replaces the administrator.
   */
  objectId: string;
  /** Kind of principal. Changing it replaces the administrator. */
  principalType: AdministratorPrincipalType;
  /**
   * Display name of the principal; it becomes the PostgreSQL role name the
   * principal signs in as (PostgreSQL truncates it to 63 characters).
   * Changing it recreates the administrator's role.
   */
  principalName: string;
  /**
   * Tenant of the principal. Changing it replaces the administrator.
   * @default the deploying subscription's tenant
   */
  tenantId?: string;
}

export interface Administrator extends Resource<
  "Azure.PostgreSQL.Administrator",
  AdministratorProps,
  {
    /** ARM resource ID of the administrator. */
    administratorId: string;
    /** Object ID of the principal. */
    objectId: string;
    /** Display name (PostgreSQL role name) of the principal. */
    principalName: string;
    /** Kind of principal. */
    principalType: string;
    /** Tenant of the principal. */
    tenantId: string;
    /** Name of the flexible server. */
    server: string;
    /** Resource group of the server. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Entra administrator of an Azure Database for PostgreSQL
 * flexible server. A server can have several Entra administrators.
 *
 * @see https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-configure-sign-in-azure-ad-authentication
 *
 * ### Granting Entra Admin
 * **Example:** Make a managed identity a server administrator
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("db", {
 *   resourceGroup: group.resourceGroupName,
 *   authConfig: { activeDirectoryAuth: "Enabled", passwordAuth: "Enabled" },
 * });
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("api", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const admin = yield* Azure.PostgreSQL.Administrator("api-admin", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   objectId: identity.principalId,
 *   principalType: "ServicePrincipal",
 *   principalName: identity.identityName,
 * });
 * ```
 *
 * **Example:** Make an Entra group the administrator
 * ```typescript
 * const admin = yield* Azure.PostgreSQL.Administrator("dbas", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   objectId: "00000000-0000-0000-0000-000000000000",
 *   principalType: "Group",
 *   principalName: "db-admins",
 * });
 * ```
 *
 * @resource
 */
export const Administrator = Resource<Administrator>(
  "Azure.PostgreSQL.Administrator",
);

interface AdministratorRef extends ServerRef {
  readonly objectId: string;
}

/**
 * Observe through the server's administrator list: a single-administrator
 * GET can answer a bare 404 for an administrator the list reports.
 */
const getAdministrator = (ref: AdministratorRef) =>
  orUndefinedIfNotFound(
    postgresql.ListAdministratorsMicrosoftEntraByServer(serverOnly(ref)),
  ).pipe(
    Effect.flatMap((page) =>
      page === undefined
        ? Effect.succeed(undefined)
        : requireSinglePage("ListAdministratorsMicrosoftEntraByServer", page),
    ),
    Effect.map((page) =>
      (page?.value ?? []).find(
        (admin) =>
          admin.properties.objectId?.toLowerCase() ===
          ref.objectId.toLowerCase(),
      ),
    ),
  );

const toAttrs = (
  ref: AdministratorRef,
  admin: postgresql.AdministratorMicrosoftEntra,
): Administrator["Attributes"] => ({
  administratorId: admin.id ?? "",
  objectId: ref.objectId,
  principalName: admin.properties.principalName ?? "",
  principalType: admin.properties.principalType ?? "",
  tenantId: admin.properties.tenantId ?? "",
  server: ref.serverName,
  resourceGroup: ref.resourceGroupName,
});

const sameText = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** PostgreSQL truncates role names to 63 bytes. */
const roleName = (name: string | undefined) => name?.slice(0, 63);

export const AdministratorProvider = () =>
  Provider.succeed(Administrator, {
    stables: ["administratorId", "objectId", "server", "resourceGroup"],

    // Administrators live inside a server; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.server, output.server) ||
        !sameText(news.objectId, output.objectId) ||
        news.principalType !== output.principalType ||
        (news.tenantId !== undefined &&
          !sameText(news.tenantId, output.tenantId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.server ?? olds?.server;
      const objectId = output?.objectId ?? olds?.objectId;
      if (
        resourceGroupName === undefined ||
        serverName === undefined ||
        objectId === undefined
      ) {
        return undefined;
      }
      const ref = { subscriptionId, resourceGroupName, serverName, objectId };
      const observed = yield* getAdministrator(ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed);
      return (yield* serverOwnedByStack(ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* AzureEnvironment.current;
      yield* ensureRegistered(env.subscriptionId, POSTGRES_NAMESPACE);
      const ref: AdministratorRef = {
        subscriptionId: env.subscriptionId,
        resourceGroupName: news.resourceGroup,
        serverName: news.server,
        objectId: news.objectId,
      };
      const desired = {
        principalType: news.principalType,
        principalName: news.principalName,
        tenantId: news.tenantId ?? env.tenantId,
      };
      const matches = (admin: postgresql.AdministratorMicrosoftEntra) =>
        admin.properties.principalType === desired.principalType &&
        roleName(admin.properties.principalName) ===
          roleName(desired.principalName) &&
        sameText(admin.properties.tenantId, desired.tenantId);

      // Observe, then ensure + sync. The PUT is accepted (202) and then can
      // fail asynchronously while the server's Entra integration or a fresh
      // principal is still propagating; that failure is not reported back,
      // the administrator just never appears. Re-issue the PUT until it
      // reads back. The PUT cannot rename an existing administrator (its
      // PostgreSQL role already exists), so a drifted one is removed first.
      const label = `PostgreSQL administrator ${news.principalName}`;
      const converge = Effect.gen(function* () {
        const observed = yield* getAdministrator(ref);
        if (observed !== undefined && matches(observed)) return observed;
        if (observed !== undefined) {
          yield* ignoreNotFound(
            postgresql
              .DeleteAdministratorsMicrosoftEntra(ref)
              .pipe(Effect.retry(whileServerBusy)),
          );
          yield* waitUntilGone(label, getAdministrator(ref), {
            interval: "5 seconds",
            times: 24,
          });
        }
        yield* postgresql
          .AdministratorsMicrosoftEntraCreateOrUpdate({
            ...ref,
            properties: desired,
          })
          .pipe(Effect.retry(whileServerBusy));
        return yield* waitForProvisioned(
          label,
          getAdministrator(ref),
          (admin) => (matches(admin) ? undefined : "Updating"),
          { interval: "5 seconds", times: 12 },
        );
      });
      const fresh = yield* converge.pipe(
        Effect.retry({
          while: (e) => e._tag === "Azure.ProvisioningTimedOut",
          times: 8,
        }),
      );
      return toAttrs(ref, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: AdministratorRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        serverName: output.server,
        objectId: output.objectId,
      };
      yield* ignoreNotFound(
        postgresql
          .DeleteAdministratorsMicrosoftEntra(ref)
          .pipe(Effect.retry(whileServerBusy)),
      );
      yield* waitUntilGone(
        `PostgreSQL administrator ${output.principalName}`,
        getAdministrator(ref),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.PostgreSQL.FlexibleServer"] },
  });
