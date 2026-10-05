import * as storagecache from "@distilled.cloud/azure/storagecache";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  ProvisioningFailed,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getAmlFilesystem } from "./AmlFilesystem.ts";
import {
  AmlFilesystemMissing,
  createLustreName,
  JOB_BUDGET,
  sameList,
} from "./Common.ts";

export interface AutoExportJobProps {
  /**
   * Resource group of the parent file system. Changing it replaces the job.
   */
  resourceGroup: string;
  /**
   * Name of the parent Azure Managed Lustre file system. The file system
   * must have blob integration (`hsm`) configured. Changing it replaces the
   * job.
   */
  amlFilesystem: string;
  /**
   * Name of the job: alphanumerics, `_` and `-`, starting and ending with an
   * alphanumeric. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the job.
   */
  name?: string;
  /**
   * Azure location of the job; must match the file system's location.
   * Changing it replaces the job.
   * @default the parent file system's location
   */
  location?: string;
  /**
   * File system path prefixes exported to the blob container (at most one
   * for now). Changing them replaces the job.
   * @default ["/"]
   */
  autoExportPrefixes?: string[];
  /**
   * `Enable` runs continuous export; `Disable` stops the active export.
   * @default "Enable"
   */
  adminStatus?: "Enable" | "Disable";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AutoExportJob extends Resource<
  "Azure.StorageCache.AutoExportJob",
  AutoExportJobProps,
  {
    /** Name of the auto export job. */
    autoExportJobName: string;
    /** ARM resource ID of the auto export job. */
    autoExportJobId: string;
    /** Name of the parent file system. */
    amlFilesystem: string;
    /** Resource group of the parent file system. */
    resourceGroup: string;
    /** Location of the job. */
    location: string;
    /** Administrative status (`Enable` / `Disable`). */
    adminStatus: string | undefined;
    /** Exported path prefixes. */
    autoExportPrefixes: string[];
    /** Operational state (`InProgress`, `Disabled`, `Failed`, ...). */
    state: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Managed Lustre auto export job — continuously exports new and
 * changed files from the Lustre namespace to the file system's blob
 * integration container.
 *
 * @see https://learn.microsoft.com/azure/azure-managed-lustre/auto-export
 *
 * ### Exporting Changes
 * **Example:** Continuously export the whole namespace
 * ```typescript
 * const exportJob = yield* Azure.StorageCache.AutoExportJob("export", {
 *   resourceGroup: group.resourceGroupName,
 *   amlFilesystem: fs.amlFilesystemName,
 * });
 * ```
 *
 * **Example:** Export one directory and pause the job
 * ```typescript
 * const exportJob = yield* Azure.StorageCache.AutoExportJob("export", {
 *   resourceGroup: group.resourceGroupName,
 *   amlFilesystem: fs.amlFilesystemName,
 *   autoExportPrefixes: ["/results"],
 *   adminStatus: "Disable",
 * });
 * ```
 *
 * @resource
 */
export const AutoExportJob = Resource<AutoExportJob>(
  "Azure.StorageCache.AutoExportJob",
);

type ObservedJob = storagecache.GetAutoExportJobResponse;

const getJob = (
  subscriptionId: string,
  resourceGroupName: string,
  amlFilesystemName: string,
  autoExportJobName: string,
) =>
  orUndefinedIfNotFound(
    storagecache.GetAutoExportJob({
      subscriptionId,
      resourceGroupName,
      amlFilesystemName,
      autoExportJobName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  amlFilesystem: string,
  name: string,
  job: ObservedJob,
): AutoExportJob["Attributes"] => ({
  autoExportJobName: name,
  autoExportJobId: job.id ?? "",
  amlFilesystem,
  resourceGroup,
  location: job.location,
  adminStatus: job.properties?.adminStatus,
  autoExportPrefixes: [...(job.properties?.autoExportPrefixes ?? [])],
  state: job.properties?.status?.state,
  provisioningState: job.properties?.provisioningState,
  tags: userTags(job.tags),
});

/** Parent file system name from a job's ARM ID. */
const filesystemOf = (armId: string | undefined) =>
  armId?.match(/\/amlFilesystems\/([^/]+)/i)?.[1];

export const AutoExportJobProvider = () =>
  Provider.succeed(AutoExportJob, {
    stables: [
      "autoExportJobName",
      "autoExportJobId",
      "amlFilesystem",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const filesystems = yield* orUndefinedIfNotFound(
        storagecache
          .ListAmlFilesystems({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListAmlFilesystems", page),
            ),
          ),
      );
      const out: AutoExportJob["Attributes"][] = [];
      for (const fs of filesystems?.value ?? []) {
        const group = resourceGroupOf(fs.id);
        if (group === undefined || fs.name === undefined) continue;
        const jobs = yield* orUndefinedIfNotFound(
          storagecache
            .ListAutoExportJobByAmlFilesystem({
              subscriptionId,
              resourceGroupName: group,
              amlFilesystemName: fs.name,
            })
            .pipe(
              Effect.flatMap((page) =>
                requireSinglePage("ListAutoExportJobByAmlFilesystem", page),
              ),
            ),
        );
        for (const job of jobs?.value ?? []) {
          const parent = filesystemOf(job.id) ?? fs.name;
          if (hasAnyAlchemyTag(job.tags) && job.name !== undefined) {
            out.push(toAttrs(group, parent, job.name, job));
          }
        }
      }
      return out;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.amlFilesystem.toLowerCase() !==
          output.amlFilesystem.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.autoExportJobName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase().replaceAll(" ", "") !==
            output.location.toLowerCase().replaceAll(" ", "")) ||
        (olds !== undefined &&
          !sameList(news.autoExportPrefixes, olds.autoExportPrefixes))
      ) {
        // Only one blob integration job can run on a file system at a time
        // (a second fails with AutoExportJobEnableFailed), so the
        // predecessor must be gone before its replacement starts.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const filesystem = output?.amlFilesystem ?? olds?.amlFilesystem;
      if (resourceGroup === undefined || filesystem === undefined) {
        return undefined;
      }
      const name =
        output?.autoExportJobName ??
        olds?.name ??
        (yield* createLustreName(id));
      const observed = yield* getJob(
        subscriptionId,
        resourceGroup,
        filesystem,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, filesystem, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageCache");
      const resourceGroup = news.resourceGroup;
      const filesystem = news.amlFilesystem;
      const name =
        news.name ?? output?.autoExportJobName ?? (yield* createLustreName(id));
      const tags = yield* desiredTags(id, news.tags);
      const adminStatus = news.adminStatus ?? "Enable";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        amlFilesystemName: filesystem,
        autoExportJobName: name,
      };
      const get = getJob(subscriptionId, resourceGroup, filesystem, name);
      // A failed job explains itself only in its status; surface it.
      const settle = waitForProvisioned(
        `auto export job ${name}`,
        get,
        (job) => job.properties?.provisioningState,
        JOB_BUDGET,
      ).pipe(
        Effect.catchTag("Azure.ProvisioningFailed", (failure) =>
          get.pipe(
            Effect.flatMap((job) => {
              const status = job?.properties?.status;
              return Effect.fail(
                new ProvisioningFailed({
                  resource: failure.resource,
                  state: failure.state,
                  message: `${failure.message}: ${status?.statusCode ?? "unknown"} ${status?.statusMessage ?? ""}`,
                }),
              );
            }),
          ),
        ),
      );

      // Observe.
      let observed = yield* get;

      // Ensure: the job lives in its file system's location.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getAmlFilesystem(subscriptionId, resourceGroup, filesystem))
            ?.location;
        if (location === undefined) {
          return yield* Effect.fail(
            new AmlFilesystemMissing({
              amlFilesystem: filesystem,
              message: `AML file system ${filesystem} in ${resourceGroup} does not exist`,
            }),
          );
        }
        yield* storagecache.AutoExportJobsCreateOrUpdate({
          ...where,
          location,
          tags,
          // The API refuses to create a job with adminStatus 'Disable'
          // ("cannot be started with adminStatus set to 'Disable'"); a
          // disabled job is created enabled and disabled by the sync below.
          properties: {
            adminStatus: "Enable",
            autoExportPrefixes: news.autoExportPrefixes,
          },
        });
      }
      observed = yield* settle;

      // Sync admin status and tags against the observed job.
      const restatus = observed.properties?.adminStatus !== adminStatus;
      const retag = tagsDiffer(observed.tags, tags);
      if (restatus || retag) {
        yield* storagecache.UpdateAutoExportJob({
          ...where,
          tags: retag ? tags : undefined,
          properties: restatus ? { adminStatus } : undefined,
        });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, filesystem, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagecache.DeleteAutoExportJob({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          amlFilesystemName: output.amlFilesystem,
          autoExportJobName: output.autoExportJobName,
        }),
      );
      yield* waitUntilGone(
        `auto export job ${output.autoExportJobName}`,
        getJob(
          subscriptionId,
          output.resourceGroup,
          output.amlFilesystem,
          output.autoExportJobName,
        ),
        JOB_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.StorageCache.AmlFilesystem",
      ],
    },
  });
