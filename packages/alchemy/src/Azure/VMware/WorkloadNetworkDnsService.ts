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

export interface WorkloadNetworkDnsServiceProps {
  /** Resource group of the private cloud. Changing it replaces the DNS service. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the DNS service. */
  privateCloud: string;
  /**
   * NSX ID of the DNS service. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the DNS service.
   */
  name?: string;
  /** Display name of the DNS service. */
  displayName?: string;
  /** IP address the DNS forwarder listens on. */
  dnsServiceIp: string;
  /** NSX ID of the default DNS zone (`Azure.VMware.WorkloadNetworkDnsZone`). */
  defaultDnsZone?: string;
  /** NSX IDs of FQDN DNS zones for conditional forwarding. */
  fqdnZones?: string[];
  /** Log level of the DNS service. */
  logLevel?: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "FATAL";
}

export interface WorkloadNetworkDnsService extends Resource<
  "Azure.VMware.WorkloadNetworkDnsService",
  WorkloadNetworkDnsServiceProps,
  {
    /** NSX ID of the DNS service. */
    dnsServiceName: string;
    /** ARM resource ID of the DNS service. */
    dnsServiceResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** IP address of the DNS service. */
    dnsServiceIp: string | undefined;
    /** Service status (`SUCCESS` or `FAILURE`). */
    status: string | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A DNS forwarder service on the NSX-T tier-1 gateway of an Azure VMware
 * Solution private cloud.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/configure-dns-azure-vmware-solution
 *
 * ### DNS Forwarding
 * **Example:** DNS forwarder with a default zone
 * ```typescript
 * const zone = yield* Azure.VMware.WorkloadNetworkDnsZone("default", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   domain: [],
 *   dnsServerIps: ["1.1.1.1"],
 * });
 * yield* Azure.VMware.WorkloadNetworkDnsService("dns", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   dnsServiceIp: "5.5.5.5",
 *   defaultDnsZone: zone.dnsZoneName,
 *   logLevel: "INFO",
 * });
 * ```
 *
 * @resource
 */
export const WorkloadNetworkDnsService = Resource<WorkloadNetworkDnsService>(
  "Azure.VMware.WorkloadNetworkDnsService",
);

const createName = (id: string) => createAvsName(id, 64);

const getWorkloadNetworkDnsService = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  dnsServiceId: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetWorkloadNetworkDnsService({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      dnsServiceId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  observed: vmware.GetWorkloadNetworkDnsServiceResponse,
): WorkloadNetworkDnsService["Attributes"] => ({
  dnsServiceName: name,
  dnsServiceResourceId: observed.id ?? "",
  resourceGroup,
  privateCloud,
  dnsServiceIp: observed.properties?.dnsServiceIp,
  status: observed.properties?.status,
  provisioningState: observed.properties?.provisioningState,
});

const desired = (news: WorkloadNetworkDnsServiceProps) => ({
  displayName: news.displayName,
  dnsServiceIp: news.dnsServiceIp,
  defaultDnsZone: news.defaultDnsZone,
  fqdnZones: news.fqdnZones,
  logLevel: news.logLevel,
});

export const WorkloadNetworkDnsServiceProvider = () =>
  Provider.succeed(WorkloadNetworkDnsService, {
    stables: [
      "dnsServiceName",
      "dnsServiceResourceId",
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
        (news.name !== undefined && news.name !== output.dnsServiceName)
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
        output?.dnsServiceName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getWorkloadNetworkDnsService(
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
        news.name ?? output?.dnsServiceName ?? (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        dnsServiceId: name,
      };
      const get = getWorkloadNetworkDnsService(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      const wait = () =>
        waitForProvisioned(
          `AVS NSX DNS service ${name}`,
          get,
          (value) => value.properties?.provisioningState,
          WORKLOAD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.CreateWorkloadNetworkDnsService({
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
        props?.dnsServiceIp !== news.dnsServiceIp ||
        (news.defaultDnsZone !== undefined &&
          props?.defaultDnsZone !== news.defaultDnsZone) ||
        (news.fqdnZones !== undefined &&
          !sameSet(props?.fqdnZones, news.fqdnZones)) ||
        (news.logLevel !== undefined && props?.logLevel !== news.logLevel)
      ) {
        yield* vmware.UpdateWorkloadNetworkDnsService({
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
        vmware.DeleteWorkloadNetworkDnsService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          dnsServiceId: output.dnsServiceName,
        }),
      );
      yield* waitUntilGone(
        `AVS NSX DNS service ${output.dnsServiceName}`,
        getWorkloadNetworkDnsService(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.dnsServiceName,
        ),
        WORKLOAD_BUDGET,
      );
    }),
  });
