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

/** Volume configuration. */
export type EdgeMachineVolumeConfiguration = hci.VolumeConfiguration;

export interface EdgeMachineVolumeProps {
  /** Resource group of the edge machine. Changing it replaces the edge machine volume. */
  resourceGroup: string;
  /** Name of the parent edge machine. Changing it replaces the edge machine volume. */
  edgeMachine: string;
  /**
   * Name of the volume. Changing it replaces the volume.
   */
  name: string;
  /** Volume configuration. */
  volumeConfiguration?: EdgeMachineVolumeConfiguration;
}

export interface EdgeMachineVolume extends Resource<
  "Azure.AzureStackHCI.EdgeMachineVolume",
  EdgeMachineVolumeProps,
  {
    /** Name of the edge machine volume. */
    volumeName: string;
    /** Name of the parent edge machine. */
    edgeMachineName: string;
    /** Resource group of the edge machine. */
    resourceGroup: string;
    /** ARM resource ID of the edge machine volume. */
    volumeId: string;
    /** Provisioning state of the edge machine volume. */
    provisioningState: string | undefined;
    /** Properties reported by the machine. */
    reportedProperties: hci.VolumeReportedProperties | undefined;
  },
  never,
  Providers
> {}

/**
 * A volume on an Azure Local edge machine's local storage. Needs a
 * claimed, connected physical machine.
 *
 * It has no tags; Alchemy treats it as owned when its parent edge machine
 * carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-local/overview
 *
 * ### Creating a Volume
 * **Example:** Volume on an edge machine
 * ```typescript
 * const machine = yield* Azure.AzureStackHCI.EdgeMachine("node-1", {
 *   resourceGroup: group.resourceGroupName,
 *   arcMachineResourceId: arcServerId,
 * });
 * yield* Azure.AzureStackHCI.EdgeMachineVolume("data", {
 *   resourceGroup: group.resourceGroupName,
 *   edgeMachine: machine.edgeMachineName,
 *   name: "data",
 *   volumeConfiguration: {},
 * });
 * ```
 *
 * @resource
 */
export const EdgeMachineVolume = Resource<EdgeMachineVolume>(
  "Azure.AzureStackHCI.EdgeMachineVolume",
);

const getEdgeMachineVolume = (
  subscriptionId: string,
  resourceGroupName: string,
  edgeMachineName: string,
  volumeName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetEdgeMachineVolume({
      subscriptionId,
      resourceGroupName,
      edgeMachineName,
      volumeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  edgeMachine: string,
  name: string,
  disk: hci.GetEdgeMachineVolumeResponse,
): EdgeMachineVolume["Attributes"] => ({
  volumeName: name,
  edgeMachineName: edgeMachine,
  resourceGroup,
  volumeId: disk.id ?? "",
  provisioningState: disk.properties?.provisioningState,
  reportedProperties: disk.properties?.reportedProperties,
});

export const EdgeMachineVolumeProvider = () =>
  Provider.succeed(EdgeMachineVolume, {
    stables: ["volumeName", "edgeMachineName", "resourceGroup", "volumeId"],

    // Removed with the parent edge machine.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.edgeMachine, output.edgeMachineName) ||
        !sameId(news.name, output.volumeName)
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
      const name = output?.volumeName ?? olds?.name;
      if (
        resourceGroup === undefined ||
        edgeMachine === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getEdgeMachineVolume(
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
      const get = getEdgeMachineVolume(
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
          !sameValue(news.volumeConfiguration, olds.volumeConfiguration)) ||
        (olds === undefined &&
          news.volumeConfiguration !== undefined &&
          !sameValue(
            news.volumeConfiguration,
            observed.properties?.volumeConfiguration,
          ))
      ) {
        yield* hci.EdgeMachineVolumesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          edgeMachineName: edgeMachine,
          volumeName: name,
          properties: { volumeConfiguration: news.volumeConfiguration },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge machine volume ${edgeMachine}/${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, edgeMachine, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteEdgeMachineVolume({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          edgeMachineName: output.edgeMachineName,
          volumeName: output.volumeName,
        }),
      );
      yield* waitUntilGone(
        `edge machine volume ${output.edgeMachineName}/${output.volumeName}`,
        getEdgeMachineVolume(
          subscriptionId,
          output.resourceGroup,
          output.edgeMachineName,
          output.volumeName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
