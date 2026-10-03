import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { deterministicGuid } from "./Ownership.ts";

export interface PrivateLinkAssociationProps {
  /**
   * ID of the management group to associate (the tenant root group's ID is
   * the tenant ID). Changing it replaces the association.
   */
  managementGroupId: string;
  /**
   * ARM ID of the resource management private link, e.g.
   * `rmpl.resourceManagementPrivateLinkId`. Changing it replaces the
   * association.
   */
  privateLink: string;
  /**
   * Whether Azure Resource Manager still accepts management traffic for the
   * management group over the public internet.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
}

export interface PrivateLinkAssociation extends Resource<
  "Azure.Authorization.PrivateLinkAssociation",
  PrivateLinkAssociationProps,
  {
    /** GUID name of the association. */
    privateLinkAssociationName: string;
    /** ARM ID of the association. */
    privateLinkAssociationId: string;
    /** Management group the association applies to. */
    managementGroupId: string;
    /** ARM ID of the associated resource management private link. */
    privateLink: string;
    /** Public network access for the management group (`Enabled`). */
    publicNetworkAccess: string | undefined;
    /** Tenant of the association. */
    tenantId: string | undefined;
    /** Scope the association covers. */
    scope: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Associates a resource management private link with a management group, so
 * Azure Resource Manager accepts management requests for every subscription
 * under the group through that private link — and, with
 * `publicNetworkAccess: "Disabled"`, only through private links.
 *
 * The association is tenant-wide in effect and requires write access on the
 * management group (`Microsoft.Authorization/privateLinkAssociations/write`,
 * e.g. Owner on the tenant root group). It has no tags or description, so
 * it is named with a GUID derived from the app, stage and logical ID.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/management/create-private-link-access-portal
 *
 * ### Restricting Management Traffic
 * **Example:** Associate a private link with the tenant root group
 * ```typescript
 * const rmpl = yield* Azure.Resources.ResourceManagementPrivateLink("arm", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Authorization.PrivateLinkAssociation("root", {
 *   managementGroupId: tenantId,
 *   privateLink: rmpl.resourceManagementPrivateLinkId,
 *   publicNetworkAccess: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const PrivateLinkAssociation = Resource<PrivateLinkAssociation>(
  "Azure.Authorization.PrivateLinkAssociation",
);

const getAssociation = (groupId: string, plaId: string) =>
  orUndefinedIfNotFound(
    resources.GetPrivateLinkAssociation({ groupId, plaId }),
  );

const toAttrs = (
  groupId: string,
  name: string,
  observed: resources.PrivateLinkAssociation,
): PrivateLinkAssociation["Attributes"] => ({
  privateLinkAssociationName: name,
  privateLinkAssociationId:
    observed.id ??
    `/providers/Microsoft.Management/managementGroups/${groupId}/providers/Microsoft.Authorization/privateLinkAssociations/${name}`,
  managementGroupId: groupId,
  privateLink: observed.properties?.privateLink ?? "",
  publicNetworkAccess: observed.properties?.publicNetworkAccess,
  tenantId: observed.properties?.tenantID,
  scope: observed.properties?.scope,
});

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").replace(/\/+$/, "").toLowerCase() ===
  (b ?? "").replace(/\/+$/, "").toLowerCase();

export const PrivateLinkAssociationProvider = () =>
  Provider.succeed(PrivateLinkAssociation, {
    stables: [
      "privateLinkAssociationName",
      "privateLinkAssociationId",
      "managementGroupId",
      "privateLink",
    ],

    // Associations carry no tags or markers, and listing needs a
    // management group: ownership cannot be proven, so nothing is listed.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (
        !isResolved(news.managementGroupId) ||
        !isResolved(news.privateLink)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        news.managementGroupId.toLowerCase() !==
          output.managementGroupId.toLowerCase() ||
        !sameId(news.privateLink, output.privateLink)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const groupId = output?.managementGroupId ?? olds?.managementGroupId;
      if (groupId === undefined) return undefined;
      const name =
        output?.privateLinkAssociationName ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getAssociation(groupId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(groupId, name, observed);
      // The GUID name is derived from this stack/stage/id; without state
      // the association may still predate us, so adoption is gated.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Authorization");
      const groupId = news.managementGroupId;
      const name =
        output?.privateLinkAssociationName ??
        (yield* deterministicGuid(id, instanceId));
      const publicNetworkAccess = news.publicNetworkAccess ?? "Enabled";

      // Observe → ensure/sync. PUT carries the whole body, so it is sent
      // only when the association is missing or differs.
      let observed = yield* getAssociation(groupId, name);
      if (
        observed === undefined ||
        !sameId(observed.properties?.privateLink, news.privateLink) ||
        observed.properties?.publicNetworkAccess !== publicNetworkAccess
      ) {
        yield* resources.PutPrivateLinkAssociation({
          groupId,
          plaId: name,
          properties: {
            privateLink: news.privateLink,
            publicNetworkAccess,
          },
        });
        observed = yield* getAssociation(groupId, name);
      }
      return toAttrs(
        groupId,
        name,
        observed ?? {
          properties: { privateLink: news.privateLink, publicNetworkAccess },
        },
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        resources.DeletePrivateLinkAssociation({
          groupId: output.managementGroupId,
          plaId: output.privateLinkAssociationName,
        }),
      );
      yield* waitUntilGone(
        `private link association ${output.privateLinkAssociationName}`,
        getAssociation(
          output.managementGroupId,
          output.privateLinkAssociationName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceManagementPrivateLink",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
