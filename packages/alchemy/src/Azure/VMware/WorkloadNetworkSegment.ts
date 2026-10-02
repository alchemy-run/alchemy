import * as vmware from "@distilled.cloud/azure/vmware";
import * as Effect from "effect/Effect";
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
  WORKLOAD_BUDGET,
  createAvsName,
  isPrivateCloudOwnedByStack,
  parentChanged,
  sameSet,
} from "./common.ts";

/** The subnet of an NSX segment. */
export interface WorkloadNetworkSegmentSubnet {
  /** Gateway address as a CIDR, e.g. `10.10.0.1/24`. */
  gatewayAddress?: string;
  /** DHCP ranges, e.g. `["10.10.0.100-10.10.0.200"]`. */
  dhcpRanges?: string[];
}

export interface WorkloadNetworkSegmentProps {
  /** Resource group of the private cloud. Changing it replaces the segment. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the segment. */
  privateCloud: string;
  /**
   * NSX ID of the segment. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the segment.
   */
  name?: string;
  /** Display name of the segment. */
  displayName?: string;
  /** Path of the tier-1 gateway to connect the segment to. */
  connectedGateway?: string;
  /** Subnet of the segment. */
  subnet?: WorkloadNetworkSegmentSubnet;
}

export interface WorkloadNetworkSegment extends Resource<
  "Azure.VMware.WorkloadNetworkSegment",
  WorkloadNetworkSegmentProps,
  {
    /** NSX ID of the segment. */
    segmentName: string;
    /** ARM resource ID of the segment. */
    segmentResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** Segment status (`SUCCESS` or `FAILURE`). */
    status: string | undefined;
    /** Names of the ports/VIFs attached to the segment. */
    portVif: string[];
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An NSX-T network segment in an Azure VMware Solution private cloud — the
 * layer-2 network workload VMs attach to.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/tutorial-nsx-t-network-segment
 *
 * ### Creating a Segment
 * **Example:** Segment on the default tier-1 gateway
 * ```typescript
 * yield* Azure.VMware.WorkloadNetworkSegment("web", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   displayName: "web",
 *   connectedGateway: "/infra/tier-1s/TNT-T1",
 *   subnet: { gatewayAddress: "10.10.0.1/24" },
 * });
 * ```
 *
 * **Example:** Segment with DHCP ranges
 * ```typescript
 * yield* Azure.VMware.WorkloadNetworkSegment("app", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   connectedGateway: "/infra/tier-1s/TNT-T1",
 *   subnet: {
 *     gatewayAddress: "10.20.0.1/24",
 *     dhcpRanges: ["10.20.0.100-10.20.0.200"],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const WorkloadNetworkSegment = Resource<WorkloadNetworkSegment>(
  "Azure.VMware.WorkloadNetworkSegment",
);

const createName = (id: string) => createAvsName(id, 64);

const getWorkloadNetworkSegment = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  segmentId: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetWorkloadNetworkSegment({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      segmentId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  observed: vmware.GetWorkloadNetworkSegmentResponse,
): WorkloadNetworkSegment["Attributes"] => ({
  segmentName: name,
  segmentResourceId: observed.id ?? "",
  resourceGroup,
  privateCloud,
  status: observed.properties?.status,
  portVif: (observed.properties?.portVif ?? []).flatMap((port) =>
    port.portName === undefined ? [] : [port.portName],
  ),
  provisioningState: observed.properties?.provisioningState,
});

const desired = (news: WorkloadNetworkSegmentProps) => ({
  displayName: news.displayName,
  connectedGateway: news.connectedGateway,
  subnet: news.subnet,
});

export const WorkloadNetworkSegmentProvider = () =>
  Provider.succeed(WorkloadNetworkSegment, {
    stables: [
      "segmentName",
      "segmentResourceId",
      "resourceGroup",
      "privateCloud",
    ],

    // Lives inside a private cloud; nuke removes it with the private cloud.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.name !== undefined && news.name !== output.segmentName)
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
      const name = output?.segmentName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getWorkloadNetworkSegment(
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
      const name = news.name ?? output?.segmentName ?? (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        segmentId: name,
      };
      const get = getWorkloadNetworkSegment(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      const wait = () =>
        waitForProvisioned(
          `AVS NSX segment ${name}`,
          get,
          (value) => value.properties?.provisioningState,
          WORKLOAD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.CreateWorkloadNetworkSegments({
          ...where,
          properties: desired(news),
        });
      }
      observed = yield* wait();

      // Sync mutable fields against the observed NSX object. NSX uses the
      // revision for optimistic concurrency, so send back the observed one.
      const props = observed.properties;
      if (
        (news.displayName !== undefined &&
          props?.displayName !== news.displayName) ||
        (news.connectedGateway !== undefined &&
          props?.connectedGateway !== news.connectedGateway) ||
        (news.subnet?.gatewayAddress !== undefined &&
          props?.subnet?.gatewayAddress !== news.subnet.gatewayAddress) ||
        (news.subnet?.dhcpRanges !== undefined &&
          !sameSet(props?.subnet?.dhcpRanges, news.subnet.dhcpRanges))
      ) {
        yield* vmware.UpdateWorkloadNetworkSegments({
          ...where,
          properties: { ...desired(news), revision: props?.revision },
        });
        observed = yield* wait();
      }

      return toAttrs(resourceGroup, privateCloud, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteWorkloadNetworkSegment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          segmentId: output.segmentName,
        }),
      );
      yield* waitUntilGone(
        `AVS NSX segment ${output.segmentName}`,
        getWorkloadNetworkSegment(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.segmentName,
        ),
        WORKLOAD_BUDGET,
      );
    }),
  });
