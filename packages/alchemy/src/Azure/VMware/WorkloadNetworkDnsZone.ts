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

export interface WorkloadNetworkDnsZoneProps {
  /** Resource group of the private cloud. Changing it replaces the DNS zone. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the DNS zone. */
  privateCloud: string;
  /**
   * NSX ID of the DNS zone. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the DNS zone.
   */
  name?: string;
  /** Display name of the DNS zone. */
  displayName?: string;
  /** Domain names forwarded by the zone (empty for a default zone). */
  domain: string[];
  /** Upstream DNS server IPs. */
  dnsServerIps: string[];
  /** Source IP of DNS queries sent upstream. */
  sourceIp?: string;
}

export interface WorkloadNetworkDnsZone extends Resource<
  "Azure.VMware.WorkloadNetworkDnsZone",
  WorkloadNetworkDnsZoneProps,
  {
    /** NSX ID of the DNS zone. */
    dnsZoneName: string;
    /** ARM resource ID of the DNS zone. */
    dnsZoneResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** Number of DNS services using the zone. */
    dnsServices: number | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A DNS zone (default or FQDN conditional-forwarding zone) for the NSX-T
 * DNS service of an Azure VMware Solution private cloud.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/configure-dns-azure-vmware-solution
 *
 * ### Conditional Forwarding
 * **Example:** Forward a corporate domain
 * ```typescript
 * yield* Azure.VMware.WorkloadNetworkDnsZone("corp", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   domain: ["corp.example.com"],
 *   dnsServerIps: ["10.0.0.4"],
 * });
 * ```
 *
 * @resource
 */
export const WorkloadNetworkDnsZone = Resource<WorkloadNetworkDnsZone>(
  "Azure.VMware.WorkloadNetworkDnsZone",
);

const createName = (id: string) => createAvsName(id, 64);

const getWorkloadNetworkDnsZone = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  dnsZoneId: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetWorkloadNetworkDnsZone({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      dnsZoneId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  observed: vmware.GetWorkloadNetworkDnsZoneResponse,
): WorkloadNetworkDnsZone["Attributes"] => ({
  dnsZoneName: name,
  dnsZoneResourceId: observed.id ?? "",
  resourceGroup,
  privateCloud,
  dnsServices: observed.properties?.dnsServices,
  provisioningState: observed.properties?.provisioningState,
});

const desired = (news: WorkloadNetworkDnsZoneProps) => ({
  displayName: news.displayName,
  domain: news.domain,
  dnsServerIps: news.dnsServerIps,
  sourceIp: news.sourceIp,
});

export const WorkloadNetworkDnsZoneProvider = () =>
  Provider.succeed(WorkloadNetworkDnsZone, {
    stables: [
      "dnsZoneName",
      "dnsZoneResourceId",
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
        (news.name !== undefined && news.name !== output.dnsZoneName)
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
      const name = output?.dnsZoneName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getWorkloadNetworkDnsZone(
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
      const name = news.name ?? output?.dnsZoneName ?? (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        dnsZoneId: name,
      };
      const get = getWorkloadNetworkDnsZone(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      const wait = () =>
        waitForProvisioned(
          `AVS NSX DNS zone ${name}`,
          get,
          (value) => value.properties?.provisioningState,
          WORKLOAD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.CreateWorkloadNetworkDnsZone({
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
        !sameSet(props?.domain, news.domain) ||
        !sameSet(props?.dnsServerIps, news.dnsServerIps) ||
        (news.sourceIp !== undefined && props?.sourceIp !== news.sourceIp)
      ) {
        yield* vmware.UpdateWorkloadNetworkDnsZone({
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
        vmware.DeleteWorkloadNetworkDnsZone({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          dnsZoneId: output.dnsZoneName,
        }),
      );
      yield* waitUntilGone(
        `AVS NSX DNS zone ${output.dnsZoneName}`,
        getWorkloadNetworkDnsZone(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.dnsZoneName,
        ),
        WORKLOAD_BUDGET,
      );
    }),
  });
