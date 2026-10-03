import * as scvmm from "@distilled.cloud/azure/scvmm";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  reveal,
  SCVMM_NAMESPACE,
  type ScVmmExtendedLocation,
  sameId,
  toExtendedLocation,
} from "./Common.ts";

export interface VmmServerProps {
  /** Resource group the VMM server is projected into. Changing it replaces the VMM server. */
  resourceGroup: string;
  /**
   * Name of the VMM server resource. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the VMM server.
   */
  name?: string;
  /**
   * Azure region of the VMM server; must match the custom location's region.
   * Changing it replaces the VMM server.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Arc custom location (Arc resource bridge) that fronts the VMM server.
   * Changing it replaces the VMM server.
   */
  extendedLocation: ScVmmExtendedLocation;
  /** FQDN or IP address of the on-premises VMM server. Changing it replaces the VMM server. */
  fqdn: string;
  /**
   * Port of the VMM server. Changing it replaces the VMM server.
   * @default 8100
   */
  port?: number;
  /** User name of a VMM administrator account. Re-sent in place when changed. */
  username?: string;
  /** Password of the VMM administrator account. Never returned by Azure; re-sent in place when changed. */
  password?: string | Redacted.Redacted<string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VmmServer extends Resource<
  "Azure.ScVmm.VmmServer",
  VmmServerProps,
  {
    /** Name of the VMM server resource. */
    vmmServerName: string;
    /** Resource group that holds the VMM server. */
    resourceGroup: string;
    /** ARM resource ID of the VMM server. */
    vmmServerId: string;
    /** Azure region of the VMM server. */
    location: string;
    /** ARM ID of the Arc custom location that fronts the VMM server. */
    customLocationId: string | undefined;
    /** FQDN or IP address of the VMM server. */
    fqdn: string | undefined;
    /** Port of the VMM server. */
    port: number | undefined;
    /** Connection status reported by the resource bridge. */
    connectionStatus: string | undefined;
    /** Unique ID of the VMM server. */
    uuid: string | undefined;
    /** Version of the VMM server. */
    version: string | undefined;
    /** Provisioning state of the VMM server. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An on-premises System Center Virtual Machine Manager (SCVMM) server
 * connected to Azure through Azure Arc. Requires an Arc resource bridge and
 * its custom location deployed next to a reachable VMM server.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/system-center-virtual-machine-manager/quickstart-connect-system-center-virtual-machine-manager-to-arc
 *
 * ### Connecting a VMM Server
 * **Example:** Connect a VMM server through a custom location
 * ```typescript
 * const vmm = yield* Azure.ScVmm.VmmServer("vmm", {
 *   resourceGroup: group.resourceGroupName,
 *   extendedLocation: { name: customLocationId },
 *   fqdn: "vmm.contoso.local",
 *   username: "contoso\\vmmadmin",
 *   password: Redacted.make(vmmPassword),
 * });
 * ```
 *
 * @resource
 */
export const VmmServer = Resource<VmmServer>("Azure.ScVmm.VmmServer");

const getVmmServer = (
  subscriptionId: string,
  resourceGroupName: string,
  vmmServerName: string,
) =>
  orUndefinedIfNotFound(
    scvmm.GetVmmServer({ subscriptionId, resourceGroupName, vmmServerName }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 54 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  value: scvmm.GetVmmServerResponse,
): VmmServer["Attributes"] => ({
  vmmServerName: name,
  resourceGroup,
  vmmServerId: value.id ?? "",
  location: value.location,
  customLocationId: value.extendedLocation?.name,
  fqdn: value.properties?.fqdn,
  port: value.properties?.port,
  connectionStatus: value.properties?.connectionStatus,
  uuid: value.properties?.uuid,
  version: value.properties?.version,
  provisioningState: value.properties?.provisioningState,
  tags: userTags(value.tags),
});

export const VmmServerProvider = () =>
  Provider.succeed(VmmServer, {
    stables: ["vmmServerName", "resourceGroup", "vmmServerId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        scvmm
          .ListVmmServerBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListVmmServerBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((value) => {
        const group = resourceGroupOf(value.id);
        return hasAnyAlchemyTag(value.tags) &&
          group !== undefined &&
          value.name !== undefined
          ? [toAttrs(group, value.name, value)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.vmmServerName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        (output.customLocationId !== undefined &&
          !sameId(news.extendedLocation.name, output.customLocationId)) ||
        (output.fqdn !== undefined && !sameId(news.fqdn, output.fqdn)) ||
        (output.port !== undefined && (news.port ?? 8100) !== output.port)
      ) {
        return {
          action: "replace",
          deleteFirst: news.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.vmmServerName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getVmmServer(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, SCVMM_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.vmmServerName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmmServerName: name,
      };
      const get = getVmmServer(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `SCVMM server ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync credentials (write-only, so compared against the
      // previous props) through the PUT upsert.
      const credentialsChanged =
        olds !== undefined &&
        (news.username !== olds.username ||
          reveal(news.password) !== reveal(olds.password));
      if (observed === undefined || credentialsChanged) {
        yield* scvmm.VmmServersCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          properties: {
            fqdn: news.fqdn,
            port: news.port,
            credentials:
              news.username === undefined && news.password === undefined
                ? undefined
                : { username: news.username, password: news.password },
          },
        });
        observed = yield* settle;
      }

      // Sync tags against the observed VMM server.
      if (tagsDiffer(observed.tags, tags)) {
        yield* scvmm.UpdateVmmServer({ ...where, tags });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        scvmm.DeleteVmmServer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmmServerName: output.vmmServerName,
        }),
      );
      yield* waitUntilGone(
        `SCVMM server ${output.vmmServerName}`,
        getVmmServer(subscriptionId, output.resourceGroup, output.vmmServerName),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
