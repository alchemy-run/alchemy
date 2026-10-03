import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createLabResourceName,
  DEVTESTLAB_NAMESPACE,
  labLocation,
} from "./Common.ts";

export interface DiskProps {
  /** Resource group of the lab. Changing it replaces the disk. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the disk. */
  lab: string;
  /** Name of the lab user that owns the disk. Changing it replaces the disk. */
  user: string;
  /**
   * Disk name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the disk.
   */
  name?: string;
  /** Storage type of the disk. Changing it replaces the disk. */
  diskType: "Standard" | "Premium" | "StandardSSD";
  /** Size of the disk in GiB. Changing it replaces the disk. */
  diskSizeGiB: number;
  /**
   * Host caching of the disk when attached (`None`, `ReadOnly`,
   * `ReadWrite`).
   */
  hostCaching?: "None" | "ReadOnly" | "ReadWrite";
  /**
   * ARM ID of the lab VM the disk is attached to. Changing it detaches the
   * disk from its current VM and attaches it to the new one; omit to keep
   * it detached.
   */
  leasedByLabVmId?: string;
  /**
   * ARM ID of an existing managed disk to import instead of creating an
   * empty one. Changing it replaces the disk.
   */
  managedDiskId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Disk extends Resource<
  "Azure.DevTestLabs.Disk",
  DiskProps,
  {
    /** Name of the disk. */
    diskName: string;
    /** ARM resource ID of the lab disk. */
    diskId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Name of the lab user that owns the disk. */
    user: string;
    /** Storage type of the disk. */
    diskType: string | undefined;
    /** Size of the disk in GiB. */
    diskSizeGiB: number | undefined;
    /** ARM ID of the underlying managed disk. */
    managedDiskId: string | undefined;
    /** ARM ID of the lab VM the disk is attached to. */
    leasedByLabVmId: string | undefined;
    /** Unique immutable identifier (GUID). */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A lab-managed data disk owned by a DevTest Labs user, which can be
 * attached to and detached from the user's lab VMs.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-attach-detach-data-disk
 *
 * ### Creating a Disk
 * **Example:** 32 GiB standard data disk
 * ```typescript
 * const disk = yield* Azure.DevTestLabs.Disk("data", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   user: user.userName,
 *   diskType: "Standard",
 *   diskSizeGiB: 32,
 * });
 * ```
 *
 * ### Attaching to a VM
 * **Example:** Attach the disk to a lab VM
 * ```typescript
 * const disk = yield* Azure.DevTestLabs.Disk("data", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   user: user.userName,
 *   diskType: "Standard",
 *   diskSizeGiB: 32,
 *   leasedByLabVmId: vm.virtualMachineId,
 * });
 * ```
 *
 * @resource
 */
export const Disk = Resource<Disk>("Azure.DevTestLabs.Disk");

const getDisk = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  userName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetDisk({
      subscriptionId,
      resourceGroupName,
      labName,
      userName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  user: string,
  name: string,
  d: devtestlabs.GetDiskResponse,
): Disk["Attributes"] => ({
  diskName: name,
  diskId: d.id ?? "",
  resourceGroup,
  lab,
  user,
  diskType: d.properties?.diskType,
  diskSizeGiB: d.properties?.diskSizeGiB,
  managedDiskId: d.properties?.managedDiskId,
  leasedByLabVmId: d.properties?.leasedByLabVmId || undefined,
  uniqueIdentifier: d.properties?.uniqueIdentifier,
  tags: userTags(d.tags),
});

const sameId = (a: string | undefined, b: string | undefined) =>
  (a || undefined)?.toLowerCase() === (b || undefined)?.toLowerCase();

export const DiskProvider = () =>
  Provider.succeed(Disk, {
    stables: ["diskName", "diskId", "resourceGroup", "lab", "user"],

    // Disks are deleted with their lab user.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        news.user.toLowerCase() !== output.user.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.diskName.toLowerCase()) ||
        news.diskType !== output.diskType ||
        news.diskSizeGiB !== output.diskSizeGiB ||
        !sameId(news.managedDiskId, olds?.managedDiskId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      const user = output?.user ?? olds?.user;
      if (
        resourceGroup === undefined ||
        lab === undefined ||
        user === undefined
      ) {
        return undefined;
      }
      const name =
        output?.diskName ?? olds?.name ?? (yield* createLabResourceName(id));
      const observed = yield* getDisk(
        subscriptionId,
        resourceGroup,
        lab,
        user,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, user, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab, user } = news;
      const name =
        news.name ?? output?.diskName ?? (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        labName: lab,
        userName: user,
        name,
      };
      const get = getDisk(subscriptionId, resourceGroup, lab, user, name);
      const wait = waitForProvisioned(
        `lab disk ${name}`,
        get,
        (d) => d.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* wait;

      // Ensure + sync host caching and tags (PUT is a long-running upsert;
      // the lease is managed by attach/detach below).
      if (
        observed === undefined ||
        (news.hostCaching !== undefined &&
          news.hostCaching !== observed.properties?.hostCaching) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* devtestlabs.DisksCreateOrUpdate({
          ...where,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties: {
            diskType: news.diskType,
            diskSizeGiB: news.diskSizeGiB,
            hostCaching: news.hostCaching ?? observed?.properties?.hostCaching,
            managedDiskId:
              news.managedDiskId ?? observed?.properties?.managedDiskId,
            // A new disk is created attached: Azure fails standalone empty
            // disks (provisioningState 'Failed', no error detail).
            leasedByLabVmId:
              observed === undefined
                ? news.leasedByLabVmId
                : observed.properties?.leasedByLabVmId,
          },
        });
        observed = yield* wait;
      }

      // Sync the lease against the observed attachment. Attach/detach are
      // long-running actions: poll until the lease reflects them.
      const waitForLease = (vmId: string | undefined) =>
        waitForProvisioned(
          `lab disk ${name} lease`,
          get,
          (d) =>
            d.properties?.provisioningState === "Failed"
              ? "Failed"
              : sameId(d.properties?.leasedByLabVmId, vmId)
                ? "Succeeded"
                : "Updating",
          { interval: "5 seconds", times: 60 },
        );
      const leased = observed.properties?.leasedByLabVmId || undefined;
      if (!sameId(leased, news.leasedByLabVmId)) {
        if (leased !== undefined) {
          yield* devtestlabs.DetachDisk({ ...where, leasedByLabVmId: leased });
          observed = yield* waitForLease(undefined);
        }
        if (news.leasedByLabVmId !== undefined) {
          yield* devtestlabs.AttachDisk({
            ...where,
            leasedByLabVmId: news.leasedByLabVmId,
          });
          observed = yield* waitForLease(news.leasedByLabVmId);
        }
      }

      return toAttrs(resourceGroup, lab, user, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        labName: output.lab,
        userName: output.user,
        name: output.diskName,
      };
      const get = getDisk(
        subscriptionId,
        output.resourceGroup,
        output.lab,
        output.user,
        output.diskName,
      );
      // An attached disk cannot be deleted: detach it first.
      const observed = yield* get;
      const leased = observed?.properties?.leasedByLabVmId || undefined;
      if (leased !== undefined) {
        yield* ignoreNotFound(
          devtestlabs.DetachDisk({ ...where, leasedByLabVmId: leased }),
        );
        yield* waitForProvisioned(
          `lab disk ${output.diskName} detach`,
          get,
          (d) => (d.properties?.leasedByLabVmId ? "Updating" : "Succeeded"),
          { interval: "5 seconds", times: 60 },
        );
      }
      yield* ignoreNotFound(devtestlabs.DeleteDisk(where));
      yield* waitUntilGone(`lab disk ${output.diskName}`, get, {
        interval: "5 seconds",
        times: 60,
      });
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
