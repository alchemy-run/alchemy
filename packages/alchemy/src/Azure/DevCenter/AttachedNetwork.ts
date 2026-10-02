import * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  createDevCenterName,
  devCenterOwnedByStage,
  sameArm,
} from "./Common.ts";

export interface AttachedNetworkProps {
  /** Resource group of the dev center. Changing it replaces the attachment. */
  resourceGroup: string;
  /** Name of the dev center. Changing it replaces the attachment. */
  devCenter: string;
  /**
   * Attachment name; pools refer to it as their `networkConnectionName`.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the attachment.
   */
  name?: string;
  /** ARM resource ID of the `NetworkConnection`. Changing it replaces the attachment. */
  networkConnectionId: string;
}

export interface AttachedNetwork extends Resource<
  "Azure.DevCenter.AttachedNetwork",
  AttachedNetworkProps,
  {
    /** Name of the attachment (a pool's `networkConnectionName`). */
    attachedNetworkName: string;
    /** ARM resource ID of the attachment. */
    attachedNetworkId: string;
    /** Name of the dev center. */
    devCenter: string;
    /** Resource group of the dev center. */
    resourceGroup: string;
    /** ARM resource ID of the attached network connection. */
    networkConnectionId: string;
    /** Location of the attached network connection. */
    networkConnectionLocation: string | undefined;
    /** Health check status of the network connection. */
    healthCheckStatus: string | undefined;
    /** Domain join type of the network connection. */
    domainJoinType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Attaches a Dev Box `NetworkConnection` to a dev center so the dev
 * center's pools can place dev boxes in that network.
 *
 * Attachments have no tags; Alchemy treats one as owned when its dev
 * center carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/dev-box/how-to-configure-network-connections#attach-a-network-connection-to-a-dev-center
 *
 * ### Attaching a Network
 * **Example:** Attach a network connection to a dev center
 * ```typescript
 * const attached = yield* Azure.DevCenter.AttachedNetwork("network", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenter: center.devCenterName,
 *   networkConnectionId: connection.networkConnectionId,
 * });
 * ```
 *
 * @resource
 */
export const AttachedNetwork = Resource<AttachedNetwork>(
  "Azure.DevCenter.AttachedNetwork",
);

type Observed = devcenter.GetAttachedNetworkByDevCenterResponse;

const getAttachedNetwork = (
  subscriptionId: string,
  resourceGroupName: string,
  devCenterName: string,
  attachedNetworkConnectionName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetAttachedNetworkByDevCenter({
      subscriptionId,
      resourceGroupName,
      devCenterName,
      attachedNetworkConnectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  devCenter: string,
  name: string,
  observed: Observed,
): AttachedNetwork["Attributes"] => ({
  attachedNetworkName: name,
  attachedNetworkId: observed.id ?? "",
  devCenter,
  resourceGroup,
  networkConnectionId: observed.properties?.networkConnectionId ?? "",
  networkConnectionLocation: observed.properties?.networkConnectionLocation,
  healthCheckStatus: observed.properties?.healthCheckStatus,
  domainJoinType: observed.properties?.domainJoinType,
});

/** Detaching fails with a conflict while pools still use the network. */
const whileInUse = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;

export const AttachedNetworkProvider = () =>
  Provider.succeed(AttachedNetwork, {
    stables: [
      "attachedNetworkName",
      "attachedNetworkId",
      "devCenter",
      "resourceGroup",
      "networkConnectionId",
    ],

    // Attachments live inside a dev center; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.devCenter, output.devCenter) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.attachedNetworkName)) ||
        !sameArm(news.networkConnectionId, output.networkConnectionId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const devCenter = output?.devCenter ?? olds?.devCenter;
      if (resourceGroup === undefined || devCenter === undefined) {
        return undefined;
      }
      const name =
        output?.attachedNetworkName ??
        olds?.name ??
        (yield* createDevCenterName(id));
      const observed = yield* getAttachedNetwork(
        subscriptionId,
        resourceGroup,
        devCenter,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, devCenter, name, observed);
      return (yield* devCenterOwnedByStage(
        subscriptionId,
        resourceGroup,
        devCenter,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const { resourceGroup, devCenter } = news;
      const name =
        news.name ??
        output?.attachedNetworkName ??
        (yield* createDevCenterName(id));
      const get = getAttachedNetwork(
        subscriptionId,
        resourceGroup,
        devCenter,
        name,
      );

      // Observe; existence-only, so ensure is the whole reconcile.
      const observed = yield* get;
      if (observed === undefined) {
        yield* devcenter.AttachedNetworksCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          devCenterName: devCenter,
          attachedNetworkConnectionName: name,
          properties: { networkConnectionId: news.networkConnectionId },
        });
      }
      const fresh = yield* waitForProvisioned(
        `attached network ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "5 seconds", times: 72 },
      );
      return toAttrs(resourceGroup, devCenter, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter
          .DeleteAttachedNetwork({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            devCenterName: output.devCenter,
            attachedNetworkConnectionName: output.attachedNetworkName,
          })
          .pipe(Effect.retry(whileInUse)),
      );
      yield* waitUntilGone(
        `attached network ${output.attachedNetworkName}`,
        getAttachedNetwork(
          subscriptionId,
          output.resourceGroup,
          output.devCenter,
          output.attachedNetworkName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.DevCenter", "Azure.Resources.ResourceGroup"],
    },
  });
