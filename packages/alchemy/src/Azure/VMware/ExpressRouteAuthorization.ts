import * as vmware from "@distilled.cloud/azure/vmware";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AVS_NAMESPACE,
  CHILD_BUDGET,
  createAvsName,
  isPrivateCloudOwnedByStack,
  parentChanged,
  redact,
  sameName,
} from "./common.ts";

export interface ExpressRouteAuthorizationProps {
  /** Resource group of the private cloud. Changing it replaces the authorization. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the authorization. */
  privateCloud: string;
  /**
   * Name of the authorization. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the authorization.
   */
  name?: string;
  /**
   * ID of the ExpressRoute circuit to authorize. Changing it replaces the
   * authorization.
   * @default the private cloud's own circuit
   */
  expressRouteId?: string;
}

export interface ExpressRouteAuthorization extends Resource<
  "Azure.VMware.ExpressRouteAuthorization",
  ExpressRouteAuthorizationProps,
  {
    /** Name of the authorization. */
    authorizationName: string;
    /** ARM resource ID of the authorization. */
    authorizationResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** ID of the ExpressRoute circuit authorization. */
    expressRouteAuthorizationId: string | undefined;
    /**
     * Authorization key; pass it to a `Microsoft.Network/connections`
     * ExpressRoute connection.
     */
    expressRouteAuthorizationKey: Redacted.Redacted<string> | undefined;
    /** ID of the authorized ExpressRoute circuit. */
    expressRouteId: string | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An authorization on an Azure VMware Solution private cloud's ExpressRoute
 * circuit. Its key lets a virtual network gateway connect to the private
 * cloud.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/deploy-azure-vmware-solution#connect-to-azure-virtual-network-with-expressroute
 *
 * ### Connecting a Virtual Network
 * **Example:** Authorization key for an ExpressRoute gateway connection
 * ```typescript
 * const auth = yield* Azure.VMware.ExpressRouteAuthorization("gateway", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 * });
 * // auth.expressRouteAuthorizationKey and cloud.circuit.expressRouteId
 * // configure the Microsoft.Network/connections resource.
 * ```
 *
 * @resource
 */
export const ExpressRouteAuthorization = Resource<ExpressRouteAuthorization>(
  "Azure.VMware.ExpressRouteAuthorization",
);

const createName = (id: string) => createAvsName(id, 64);

const getAuthorization = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  authorizationName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetAuthorization({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      authorizationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  authorization: vmware.GetAuthorizationResponse,
): ExpressRouteAuthorization["Attributes"] => ({
  authorizationName: name,
  authorizationResourceId: authorization.id ?? "",
  resourceGroup,
  privateCloud,
  expressRouteAuthorizationId:
    authorization.properties?.expressRouteAuthorizationId,
  expressRouteAuthorizationKey: redact(
    authorization.properties?.expressRouteAuthorizationKey,
  ),
  expressRouteId: authorization.properties?.expressRouteId,
  provisioningState: authorization.properties?.provisioningState,
});

export const ExpressRouteAuthorizationProvider = () =>
  Provider.succeed(ExpressRouteAuthorization, {
    stables: [
      "authorizationName",
      "authorizationResourceId",
      "resourceGroup",
      "privateCloud",
      "expressRouteAuthorizationId",
      "expressRouteAuthorizationKey",
    ],

    // Authorizations live inside a private cloud; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.name !== undefined && news.name !== output.authorizationName) ||
        (olds !== undefined &&
          !sameName(news.expressRouteId, olds.expressRouteId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateCloud = output?.privateCloud ?? olds?.privateCloud;
      if (resourceGroup === undefined || privateCloud === undefined) {
        return undefined;
      }
      const name =
        output?.authorizationName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getAuthorization(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, privateCloud, name, observed);
      return (yield* isPrivateCloudOwnedByStack(
        subscriptionId,
        resourceGroup,
        privateCloud,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, AVS_NAMESPACE);
      const { resourceGroup, privateCloud } = news;
      const name =
        news.name ?? output?.authorizationName ?? (yield* createName(id));
      const get = getAuthorization(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );

      // Observe; ensure. Nothing is mutable after creation.
      const observed = yield* get;
      if (observed === undefined) {
        yield* vmware.AuthorizationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          privateCloudName: privateCloud,
          authorizationName: name,
          properties: news.expressRouteId
            ? { expressRouteId: news.expressRouteId }
            : {},
        });
      }
      const fresh = yield* waitForProvisioned(
        `AVS ExpressRoute authorization ${name}`,
        get,
        (authorization) => authorization.properties?.provisioningState,
        CHILD_BUDGET,
      );
      return toAttrs(resourceGroup, privateCloud, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteAuthorization({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          authorizationName: output.authorizationName,
        }),
      );
      yield* waitUntilGone(
        `AVS ExpressRoute authorization ${output.authorizationName}`,
        getAuthorization(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.authorizationName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
