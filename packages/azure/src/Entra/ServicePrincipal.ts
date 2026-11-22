import * as servicePrincipals from "@distilled.cloud/microsoft-graph/servicePrincipals";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { waitForProvisioned } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ALCHEMY_TAG_FILTER,
  deleteAndPurge,
  desiredGraphTags,
  hasAnyAlchemyGraphTag,
  isOwnedGraph,
  orUndefinedIfGone,
  readRecorded,
  REPLICATION_LAG,
  sameGraphTags,
  userGraphTags,
} from "./internal.ts";

export interface ServicePrincipalProps {
  /**
   * Application (client) ID the service principal represents, e.g.
   * `app.appId`. One application has at most one service principal per
   * tenant. Changing it replaces the service principal.
   */
  appId: string;
  /**
   * Whether the service principal may sign in. `false` blocks new tokens
   * for the application in this tenant. Changing it updates the service
   * principal in place.
   * @default true
   */
  accountEnabled?: boolean;
  /**
   * Require an app role assignment before users or apps get tokens for
   * this application. Changing it updates the service principal in place.
   * @default false
   */
  appRoleAssignmentRequired?: boolean;
  /**
   * Free-text description.
   * @default no description
   */
  description?: string;
  /**
   * Notes for the people who manage the service principal.
   * @default no notes
   */
  notes?: string;
  /**
   * User tags (plain strings). Alchemy adds its ownership tags
   * (`alchemy::stack=<stack>`, `alchemy::stage=<stage>`, `alchemy::id=<id>`).
   * @default []
   */
  tags?: string[];
}

export interface ServicePrincipal extends Resource<
  "Azure.Entra.ServicePrincipal",
  ServicePrincipalProps,
  {
    /**
     * Object ID of the service principal. This is the `principalId` an
     * `Azure.Authorization.RoleAssignment` grants roles to.
     */
    objectId: string;
    /** Application (client) ID it represents. */
    appId: string;
    /** Entra tenant (directory) ID. */
    tenantId: string;
    /** Display name (the application's). */
    displayName: string;
    /** Whether the service principal may sign in. */
    accountEnabled: boolean;
    /** User tags (Alchemy ownership tags removed). */
    tags: string[];
  },
  never,
  Providers
> {}

/**
 * A Microsoft Entra ID service principal (Microsoft Graph
 * `servicePrincipal`): the instance of an application in a tenant. Azure
 * RBAC roles are assigned to it, not to the application.
 *
 * Alchemy tags the service principal like the application
 * (`alchemy::stack=<stack>`, `alchemy::stage=<stage>`, `alchemy::id=<id>` in
 * `tags`). Destroy deletes it and purges it from the deleted items. A new
 * service principal takes up to about two minutes to replicate to Azure
 * RBAC; `Azure.Authorization.RoleAssignment` waits for it. If a service
 * principal for the application already exists (a concurrent create),
 * Alchemy uses it.
 *
 * :::caution[Changing `appId` replaces the service principal]
 * The new service principal has a new `objectId`, so every role assignment
 * granted to it is replaced too. Every other prop updates in place.
 * :::
 *
 * :::caution[The deploying identity needs a Microsoft Graph permission]
 * The deploying service principal needs the Microsoft Graph application
 * permission `Application.ReadWrite.OwnedBy` (or
 * `Application.ReadWrite.All`), with admin consent.
 * :::
 *
 * @see https://learn.microsoft.com/graph/api/resources/serviceprincipal
 *
 * ### Creating a Service Principal
 * One application has at most one service principal per tenant.
 *
 * **Example:** Service principal for an application
 * ```typescript
 * const app = yield* Azure.Entra.Application("Ci");
 * const principal = yield* Azure.Entra.ServicePrincipal("CiPrincipal", {
 *   appId: app.appId,
 * });
 * ```
 *
 * **Example:** Description and notes for the people who manage it
 * ```typescript
 * const principal = yield* Azure.Entra.ServicePrincipal("CiPrincipal", {
 *   appId: app.appId,
 *   description: "Deploys the shop stack",
 *   notes: "Owned by the platform team",
 *   tags: ["team:platform"],
 * });
 * ```
 *
 * ### Granting Azure Roles
 * Pass `objectId` as the role assignment's `principalId`, with
 * `principalType: "ServicePrincipal"`.
 *
 * **Example:** Grant an application a role on a storage account
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files");
 * const app = yield* Azure.Entra.Application("Ci");
 * const principal = yield* Azure.Entra.ServicePrincipal("CiPrincipal", {
 *   appId: app.appId,
 * });
 * yield* Azure.Authorization.RoleAssignment("CiReadsBlobs", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
 *   principalId: principal.objectId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * ### Signing In from CI
 * Credentials belong to the application, not the service principal. Add a
 * federated credential (or a client secret) to the application, and sign
 * in with its `appId`.
 *
 * **Example:** GitHub Actions deploys to one resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const app = yield* Azure.Entra.Application("Deployer");
 * const principal = yield* Azure.Entra.ServicePrincipal("DeployerPrincipal", {
 *   appId: app.appId,
 * });
 * yield* Azure.Entra.FederatedIdentityCredential("DeployerGitHubMain", {
 *   applicationObjectId: app.objectId,
 *   issuer: "https://token.actions.githubusercontent.com",
 *   subject: "repo:my-org/my-repo:ref:refs/heads/main",
 * });
 * yield* Azure.Authorization.RoleAssignment("DeployerContributes", {
 *   scope: group.resourceGroupId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
 *   principalId: principal.objectId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * ### Restricting Sign-In
 * **Example:** A disabled service principal that requires role assignment
 * ```typescript
 * const app = yield* Azure.Entra.Application("Internal");
 * const principal = yield* Azure.Entra.ServicePrincipal("InternalPrincipal", {
 *   appId: app.appId,
 *   accountEnabled: false,
 *   appRoleAssignmentRequired: true,
 * });
 * ```
 *
 * @resource
 */
export const ServicePrincipal = Resource<ServicePrincipal>("Azure.Entra.ServicePrincipal");

type ObservedServicePrincipal = servicePrincipals.GetServicePrincipalResponse;

const getById = (objectId: string) =>
  orUndefinedIfGone(servicePrincipals.getServicePrincipal({ servicePrincipalId: objectId }));

/** A service principal recorded in state (tolerates replication lag). */
const getRecorded = (objectId: string) =>
  readRecorded(servicePrincipals.getServicePrincipal({ servicePrincipalId: objectId }));

const getByAppId = (appId: string) =>
  orUndefinedIfGone(servicePrincipals.getServicePrincipalByAppId({ appId }));

const toAttrs = (
  tenantId: string,
  sp: ObservedServicePrincipal,
): ServicePrincipal["Attributes"] => ({
  objectId: sp.id ?? "",
  appId: sp.appId ?? "",
  tenantId,
  displayName: sp.displayName ?? "",
  accountEnabled: sp.accountEnabled ?? true,
  tags: userGraphTags(sp.tags),
});

export const ServicePrincipalProvider = () =>
  Provider.succeed(ServicePrincipal, {
    stables: ["objectId", "appId", "tenantId"],

    list: Effect.fn(function* () {
      const { tenantId } = yield* AzureEnvironment.current;
      const principals = yield* Stream.runCollect(
        servicePrincipals.listServicePrincipal.items({
          filter: ALCHEMY_TAG_FILTER,
          consistencyLevel: "eventual",
          count: true,
        }),
      );
      return [...principals]
        .filter((sp) => hasAnyAlchemyGraphTag(sp.tags))
        .map((sp) => toAttrs(tenantId, sp));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // `appId` is a stable attribute upstream; unresolved means its
      // application is being replaced.
      if (!("appId" in news) || !isResolved(news.appId)) return { action: "replace" } as const;
      if (news.appId !== output.appId) return { action: "replace" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { tenantId } = yield* AzureEnvironment.current;
      const observed =
        output?.objectId !== undefined
          ? yield* getRecorded(output.objectId)
          : olds?.appId !== undefined
            ? yield* getByAppId(olds.appId)
            : undefined;
      if (observed === undefined) return undefined;
      const attrs = toAttrs(tenantId, observed);
      return (yield* isOwnedGraph(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { tenantId } = yield* AzureEnvironment.current;
      const tags = yield* desiredGraphTags(id, news.tags);
      const desired = {
        accountEnabled: news.accountEnabled ?? true,
        appRoleAssignmentRequired: news.appRoleAssignmentRequired ?? false,
        description: news.description ?? null,
        notes: news.notes ?? null,
      };

      // Observe: by object ID, else by the application it represents.
      let observed =
        output?.objectId !== undefined && output.appId === news.appId
          ? yield* getRecorded(output.objectId)
          : undefined;
      observed ??= yield* getByAppId(news.appId);

      // Ensure. Right after the application is created Graph reports
      // `NoBackingApplicationObject`; a concurrent create reports
      // `MultipleObjectsWithSameKeyValue` and the existing one is used.
      if (observed === undefined) {
        const created = yield* servicePrincipals
          .createServicePrincipal({ appId: news.appId, tags, ...desired })
          .pipe(
            Effect.retry(REPLICATION_LAG),
            Effect.map((sp) => sp.id),
            Effect.catchTag("MultipleObjectsWithSameKeyValue", () => Effect.succeed(undefined)),
          );
        observed = yield* waitForProvisioned(
          `service principal for ${news.appId}`,
          created !== undefined ? getById(created) : getByAppId(news.appId),
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      }

      // Sync against the observed service principal.
      const changed: Pick<
        servicePrincipals.UpdateServicePrincipalRequest,
        "accountEnabled" | "appRoleAssignmentRequired" | "description" | "notes" | "tags"
      > = {};
      if ((observed.accountEnabled ?? true) !== desired.accountEnabled) {
        changed.accountEnabled = desired.accountEnabled;
      }
      if ((observed.appRoleAssignmentRequired ?? false) !== desired.appRoleAssignmentRequired) {
        changed.appRoleAssignmentRequired = desired.appRoleAssignmentRequired;
      }
      if ((observed.description ?? null) !== desired.description) {
        changed.description = desired.description;
      }
      if ((observed.notes ?? null) !== desired.notes) changed.notes = desired.notes;
      if (!sameGraphTags(observed.tags, tags)) changed.tags = tags;
      if (Object.keys(changed).length > 0) {
        yield* servicePrincipals
          .updateServicePrincipal({ servicePrincipalId: observed.id!, ...changed })
          .pipe(Effect.retry(REPLICATION_LAG));
        observed = { ...observed, ...changed };
      }
      return toAttrs(tenantId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      // A 404 right after create can be lag; only a settled 404 is "gone".
      if ((yield* getRecorded(output.objectId)) === undefined) return;
      yield* deleteAndPurge({
        name: `service principal ${output.objectId}`,
        objectId: output.objectId,
        get: getById(output.objectId),
        remove: servicePrincipals.deleteServicePrincipal({ servicePrincipalId: output.objectId }),
      });
    }),
  });
