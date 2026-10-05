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

export interface AutoImportJobProps {
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
   * Blob path prefixes imported into the namespace (up to 100). Changing
   * them replaces the job.
   * @default ["/"]
   */
  autoImportPrefixes?: string[];
  /**
   * How conflicts between blobs and existing namespace entries are handled:
   * `Fail` stops the job, `Skip` passes over the conflict, `OverwriteIfDirty`
   * re-imports conflicting, dirty, or released entries, `OverwriteAlways`
   * also re-imports restored entries. Changing it replaces the job.
   * @default "Skip"
   */
  conflictResolutionMode?:
    | "Fail"
    | "Skip"
    | "OverwriteIfDirty"
    | "OverwriteAlways";
  /**
   * Whether blob deletions are applied to the namespace (only with
   * `OverwriteIfDirty`). Changing it replaces the job.
   * @default false
   */
  enableDeletions?: boolean;
  /**
   * Non-conflict errors tolerated before the job fails: `-1` is unlimited,
   * `0` fails on the first error. Changing it replaces the job.
   * @default -1
   */
  maximumErrors?: number;
  /**
   * `Enable` runs continuous import; `Disable` stops the active import.
   * @default "Enable"
   */
  adminStatus?: "Enable" | "Disable";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AutoImportJob extends Resource<
  "Azure.StorageCache.AutoImportJob",
  AutoImportJobProps,
  {
    /** Name of the auto import job. */
    autoImportJobName: string;
    /** ARM resource ID of the auto import job. */
    autoImportJobId: string;
    /** Name of the parent file system. */
    amlFilesystem: string;
    /** Resource group of the parent file system. */
    resourceGroup: string;
    /** Location of the job. */
    location: string;
    /** Administrative status (`Enable` / `Disable`). */
    adminStatus: string | undefined;
    /** Imported blob path prefixes. */
    autoImportPrefixes: string[];
    /** Conflict resolution mode. */
    conflictResolutionMode: string | undefined;
    /** Whether blob deletions are applied to the namespace. */
    enableDeletions: boolean | undefined;
    /** Non-conflict errors tolerated before the job fails. */
    maximumErrors: number | undefined;
    /** Operational state (`InProgress`, `Disabling`, `Disabled`, `Failed`). */
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
 * An Azure Managed Lustre auto import job — continuously imports new,
 * changed, and (optionally) deleted blobs from the file system's blob
 * integration container into the Lustre namespace. The storage account must
 * have the blob change feed enabled.
 *
 * @see https://learn.microsoft.com/azure/azure-managed-lustre/auto-import
 *
 * ### Importing Changes
 * **Example:** Continuously import the whole container
 * ```typescript
 * const importJob = yield* Azure.StorageCache.AutoImportJob("import", {
 *   resourceGroup: group.resourceGroupName,
 *   amlFilesystem: fs.amlFilesystemName,
 * });
 * ```
 *
 * **Example:** Import two prefixes, overwriting dirty files and applying deletions
 * ```typescript
 * const importJob = yield* Azure.StorageCache.AutoImportJob("import", {
 *   resourceGroup: group.resourceGroupName,
 *   amlFilesystem: fs.amlFilesystemName,
 *   autoImportPrefixes: ["/datasets", "/models"],
 *   conflictResolutionMode: "OverwriteIfDirty",
 *   enableDeletions: true,
 * });
 * ```
 *
 * @resource
 */
export const AutoImportJob = Resource<AutoImportJob>(
  "Azure.StorageCache.AutoImportJob",
);

type ObservedJob = storagecache.GetAutoImportJobResponse;

const getJob = (
  subscriptionId: string,
  resourceGroupName: string,
  amlFilesystemName: string,
  autoImportJobName: string,
) =>
  orUndefinedIfNotFound(
    storagecache.GetAutoImportJob({
      subscriptionId,
      resourceGroupName,
      amlFilesystemName,
      autoImportJobName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  amlFilesystem: string,
  name: string,
  job: ObservedJob,
): AutoImportJob["Attributes"] => ({
  autoImportJobName: name,
  autoImportJobId: job.id ?? "",
  amlFilesystem,
  resourceGroup,
  location: job.location,
  adminStatus: job.properties?.adminStatus,
  autoImportPrefixes: [...(job.properties?.autoImportPrefixes ?? [])],
  conflictResolutionMode: job.properties?.conflictResolutionMode,
  enableDeletions: job.properties?.enableDeletions,
  maximumErrors: job.properties?.maximumErrors,
  state: job.properties?.status?.state,
  provisioningState: job.properties?.provisioningState,
  tags: userTags(job.tags),
});

/** Parent file system name from a job's ARM ID. */
const filesystemOf = (armId: string | undefined) =>
  armId?.match(/\/amlFilesystems\/([^/]+)/i)?.[1];

export const AutoImportJobProvider = () =>
  Provider.succeed(AutoImportJob, {
    stables: [
      "autoImportJobName",
      "autoImportJobId",
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
      const out: AutoImportJob["Attributes"][] = [];
      for (const fs of filesystems?.value ?? []) {
        const group = resourceGroupOf(fs.id);
        if (group === undefined || fs.name === undefined) continue;
        const jobs = yield* orUndefinedIfNotFound(
          storagecache
            .ListAutoImportJobByAmlFilesystem({
              subscriptionId,
              resourceGroupName: group,
              amlFilesystemName: fs.name,
            })
            .pipe(
              Effect.flatMap((page) =>
                requireSinglePage("ListAutoImportJobByAmlFilesystem", page),
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
          news.name.toLowerCase() !== output.autoImportJobName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase().replaceAll(" ", "") !==
            output.location.toLowerCase().replaceAll(" ", "")) ||
        (olds !== undefined &&
          (!sameList(news.autoImportPrefixes, olds.autoImportPrefixes) ||
            news.conflictResolutionMode !== olds.conflictResolutionMode ||
            news.enableDeletions !== olds.enableDeletions ||
            news.maximumErrors !== olds.maximumErrors))
      ) {
        return { action: "replace" } as const;
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
        output?.autoImportJobName ??
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
        news.name ?? output?.autoImportJobName ?? (yield* createLustreName(id));
      const tags = yield* desiredTags(id, news.tags);
      const adminStatus = news.adminStatus ?? "Enable";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        amlFilesystemName: filesystem,
        autoImportJobName: name,
      };
      const get = getJob(subscriptionId, resourceGroup, filesystem, name);
      // A failed job explains itself only in its status; surface it.
      const settle = waitForProvisioned(
        `auto import job ${name}`,
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
        yield* storagecache.AutoImportJobsCreateOrUpdate({
          ...where,
          location,
          tags,
          // The API refuses to create a job with adminStatus 'Disable'
          // ("cannot be started with adminStatus set to 'Disable'"); a
          // disabled job is created enabled and disabled by the sync below.
          properties: {
            adminStatus: "Enable",
            autoImportPrefixes: news.autoImportPrefixes,
            conflictResolutionMode: news.conflictResolutionMode,
            enableDeletions: news.enableDeletions,
            maximumErrors: news.maximumErrors,
          },
        });
      }
      observed = yield* settle;

      // Sync admin status and tags against the observed job.
      const restatus = observed.properties?.adminStatus !== adminStatus;
      const retag = tagsDiffer(observed.tags, tags);
      if (restatus || retag) {
        yield* storagecache.UpdateAutoImportJob({
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
        storagecache.DeleteAutoImportJob({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          amlFilesystemName: output.amlFilesystem,
          autoImportJobName: output.autoImportJobName,
        }),
      );
      yield* waitUntilGone(
        `auto import job ${output.autoImportJobName}`,
        getJob(
          subscriptionId,
          output.resourceGroup,
          output.amlFilesystem,
          output.autoImportJobName,
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
