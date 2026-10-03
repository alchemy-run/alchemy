import * as hci from "@distilled.cloud/azure/azurestackhci";
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
  HCI_NAMESPACE,
  isStackOwnedTags,
  sameId,
  sameValue,
} from "./Common.ts";
import { getHciEdgeMachine } from "./EdgeMachine.ts";

/** Volumes to carve out of the disk. */
export type EdgeMachineDiskConfiguration = hci.DiskConfiguration;

export interface EdgeMachineDiskProps {
  /** Resource group of the edge machine. Changing it replaces the edge machine disk. */
  resourceGroup: string;
  /** Name of the parent edge machine. Changing it replaces the edge machine disk. */
  edgeMachine: string;
  /**
   * Name of the disk (as reported by the machine). Changing it replaces the disk.
   */
  name: string;
  /** Volumes to carve out of the disk. */
  diskConfiguration?: EdgeMachineDiskConfiguration;
}

export interface EdgeMachineDisk extends Resource<
  "Azure.AzureStackHCI.EdgeMachineDisk",
  EdgeMachineDiskProps,
  {
    /** Name of the edge machine disk. */
    diskName: string;
    /** Name of the parent edge machine. */
    edgeMachineName: string;
    /** Resource group of the edge machine. */
    resourceGroup: string;
    /** ARM resource ID of the edge machine disk. */
    diskId: string;
    /** Provisioning state of the edge machine disk. */
    provisioningState: string | undefined;
    /** Properties reported by the machine. */
    reportedProperties: hci.DiskReportedProperties | undefined;
  },
  never,
  Providers
> {}

/**
 * A local disk of an Azure Local edge machine and the volumes to carve
 * out of it. Needs a claimed, connected physical machine.
 *
 * It has no tags; Alchemy treats it as owned when its parent edge machine
 * carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-local/overview
 *
 * ### Configuring a Disk
 * **Example:** Volumes on a local disk
 * ```typescript
 * const machine = yield* Azure.AzureStackHCI.EdgeMachine("node-1", {
 *   resourceGroup: group.resourceGroupName,
 *   arcMachineResourceId: arcServerId,
 * });
 * yield* Azure.AzureStackHCI.EdgeMachineDisk("data-disk", {
 *   resourceGroup: group.resourceGroupName,
 *   edgeMachine: machine.edgeMachineName,
 *   name: "disk1",
 *   diskConfiguration: { volumes: [{ ... }] },
 * });
 * ```
 *
 * @resource
 */
export const EdgeMachineDisk = Resource<EdgeMachineDisk>(
  "Azure.AzureStackHCI.EdgeMachineDisk",
);

const getEdgeMachineDisk = (
  subscriptionId: string,
  resourceGroupName: string,
  edgeMachineName: string,
  diskName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetEdgeMachineDisk({
      subscriptionId,
      resourceGroupName,
      edgeMachineName,
      diskName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  edgeMachine: string,
  name: string,
  disk: hci.GetEdgeMachineDiskResponse,
): EdgeMachineDisk["Attributes"] => ({
  diskName: name,
  edgeMachineName: edgeMachine,
  resourceGroup,
  diskId: disk.id ?? "",
  provisioningState: disk.properties?.provisioningState,
  reportedProperties: disk.properties?.reportedProperties,
});

export const EdgeMachineDiskProvider = () =>
  Provider.succeed(EdgeMachineDisk, {
    stables: ["diskName", "edgeMachineName", "resourceGroup", "diskId"],

    // Removed with the parent edge machine.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.edgeMachine, output.edgeMachineName) ||
        !sameId(news.name, output.diskName)
      ) {
        // The name is fixed per parent, so the old one must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const edgeMachine = output?.edgeMachineName ?? olds?.edgeMachine;
      const name = output?.diskName ?? olds?.name;
      if (
        resourceGroup === undefined ||
        edgeMachine === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getEdgeMachineDisk(
        subscriptionId,
        resourceGroup,
        edgeMachine,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, edgeMachine, name, observed);
      const parent = yield* getHciEdgeMachine(
        subscriptionId,
        resourceGroup,
        edgeMachine,
      );
      return (yield* isStackOwnedTags(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const { resourceGroup, edgeMachine } = news;
      const name = news.name;
      const get = getEdgeMachineDisk(
        subscriptionId,
        resourceGroup,
        edgeMachine,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the configuration is written through the PUT upsert.
      // Compare with the last deployed props (Azure normalizes the observed
      // configuration); on adoption, compare with the observed one.
      if (
        observed === undefined ||
        (olds !== undefined &&
          !sameValue(news.diskConfiguration, olds.diskConfiguration)) ||
        (olds === undefined &&
          news.diskConfiguration !== undefined &&
          !sameValue(
            news.diskConfiguration,
            observed.properties?.diskConfiguration,
          ))
      ) {
        yield* hci.EdgeMachineDisksCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          edgeMachineName: edgeMachine,
          diskName: name,
          properties: { diskConfiguration: news.diskConfiguration },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge machine disk ${edgeMachine}/${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, edgeMachine, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteEdgeMachineDisk({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          edgeMachineName: output.edgeMachineName,
          diskName: output.diskName,
        }),
      );
      yield* waitUntilGone(
        `edge machine disk ${output.edgeMachineName}/${output.diskName}`,
        getEdgeMachineDisk(
          subscriptionId,
          output.resourceGroup,
          output.edgeMachineName,
          output.diskName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
