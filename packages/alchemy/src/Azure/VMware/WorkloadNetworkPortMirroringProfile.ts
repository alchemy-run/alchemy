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
} from "./common.ts";

export interface WorkloadNetworkPortMirroringProfileProps {
  /** Resource group of the private cloud. Changing it replaces the port mirroring profile. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the port mirroring profile. */
  privateCloud: string;
  /**
   * NSX ID of the port mirroring profile. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the port mirroring profile.
   */
  name?: string;
  /** Display name of the profile. */
  displayName?: string;
  /** Traffic direction to mirror. */
  direction: "INGRESS" | "EGRESS" | "BIDIRECTIONAL";
  /** NSX ID of the source VM group. */
  source: string;
  /** NSX ID of the destination VM group. */
  destination: string;
}

export interface WorkloadNetworkPortMirroringProfile extends Resource<
  "Azure.VMware.WorkloadNetworkPortMirroringProfile",
  WorkloadNetworkPortMirroringProfileProps,
  {
    /** NSX ID of the port mirroring profile. */
    portMirroringName: string;
    /** ARM resource ID of the port mirroring profile. */
    portMirroringResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** Profile status (`SUCCESS` or `FAILURE`). */
    status: string | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An NSX-T port mirroring profile in an Azure VMware Solution private cloud
 * — copies traffic from a source VM group to a destination VM group.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/configure-port-mirroring-azure-vmware-solution
 *
 * ### Mirroring Traffic
 * **Example:** Mirror both directions between VM groups
 * ```typescript
 * const sources = yield* Azure.VMware.WorkloadNetworkVMGroup("sources", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   members: [],
 * });
 * const collectors = yield* Azure.VMware.WorkloadNetworkVMGroup("collectors", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   members: [],
 * });
 * yield* Azure.VMware.WorkloadNetworkPortMirroringProfile("mirror", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   direction: "BIDIRECTIONAL",
 *   source: sources.vmGroupName,
 *   destination: collectors.vmGroupName,
 * });
 * ```
 *
 * @resource
 */
export const WorkloadNetworkPortMirroringProfile =
  Resource<WorkloadNetworkPortMirroringProfile>(
    "Azure.VMware.WorkloadNetworkPortMirroringProfile",
  );

const createName = (id: string) => createAvsName(id, 64);

const getWorkloadNetworkPortMirroringProfile = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  portMirroringId: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetWorkloadNetworkPortMirroring({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      portMirroringId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  observed: vmware.GetWorkloadNetworkPortMirroringResponse,
): WorkloadNetworkPortMirroringProfile["Attributes"] => ({
  portMirroringName: name,
  portMirroringResourceId: observed.id ?? "",
  resourceGroup,
  privateCloud,
  status: observed.properties?.status,
  provisioningState: observed.properties?.provisioningState,
});

const desired = (news: WorkloadNetworkPortMirroringProfileProps) => ({
  displayName: news.displayName,
  direction: news.direction,
  source: news.source,
  destination: news.destination,
});

export const WorkloadNetworkPortMirroringProfileProvider = () =>
  Provider.succeed(WorkloadNetworkPortMirroringProfile, {
    stables: [
      "portMirroringName",
      "portMirroringResourceId",
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
        (news.name !== undefined && news.name !== output.portMirroringName)
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
        output?.portMirroringName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getWorkloadNetworkPortMirroringProfile(
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
        news.name ?? output?.portMirroringName ?? (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        portMirroringId: name,
      };
      const get = getWorkloadNetworkPortMirroringProfile(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      const wait = () =>
        waitForProvisioned(
          `AVS NSX port mirroring profile ${name}`,
          get,
          (value) => value.properties?.provisioningState,
          WORKLOAD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.CreateWorkloadNetworkPortMirroring({
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
        props?.direction !== news.direction ||
        props?.source !== news.source ||
        props?.destination !== news.destination
      ) {
        yield* vmware.UpdateWorkloadNetworkPortMirroring({
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
        vmware.DeleteWorkloadNetworkPortMirroring({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          portMirroringId: output.portMirroringName,
        }),
      );
      yield* waitUntilGone(
        `AVS NSX port mirroring profile ${output.portMirroringName}`,
        getWorkloadNetworkPortMirroringProfile(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.portMirroringName,
        ),
        WORKLOAD_BUDGET,
      );
    }),
  });
