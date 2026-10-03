import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
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
  createStreamAnalyticsName,
  getStreamingJob,
  lower,
  matchesObserved,
  checkResourceGroup,
} from "./Common.ts";

export interface StreamingJobStorageAccount {
  /** Name of the Azure Storage account. */
  accountName: string;
  /**
   * Account key, required when `authenticationMode` is `ConnectionString`.
   * Azure never returns it, so a change is detected against the previous
   * props.
   */
  accountKey?: string;
  /**
   * How the job authenticates to the account.
   * @default "ConnectionString"
   */
  authenticationMode?: "Msi" | "UserToken" | "ConnectionString";
}

export interface StreamingJobProps {
  /**
   * Resource group the job is created in, at most 80 characters (Stream
   * Analytics rejects longer names). Changing it replaces the job.
   */
  resourceGroup: string;
  /**
   * Job name: 3-63 letters, digits, hyphens, and underscores. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the job.
   */
  name?: string;
  /**
   * Azure location of the job. Changing it replaces the job.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Whether the job runs in the cloud or on IoT Edge devices. Changing it
   * replaces the job.
   * @default "Cloud"
   */
  jobType?: "Cloud" | "Edge";
  /**
   * Pricing SKU.
   * @default "Standard"
   */
  sku?: "Standard" | (string & {});
  /**
   * What to do with events that arrive out of order.
   * @default Azure's default (`Adjust`)
   */
  eventsOutOfOrderPolicy?: "Adjust" | "Drop";
  /**
   * Maximum delay, in seconds, within which out-of-order events are put
   * back in order.
   */
  eventsOutOfOrderMaxDelayInSeconds?: number;
  /**
   * Maximum delay, in seconds, for late-arriving events to be included;
   * `-1` waits indefinitely.
   */
  eventsLateArrivalMaxDelayInSeconds?: number;
  /**
   * What to do with output events that cannot be written (malformed,
   * wrong column types).
   * @default Azure's default (`Stop`)
   */
  outputErrorPolicy?: "Stop" | "Drop";
  /** .NET culture name used to parse and format data, e.g. `en-US`. */
  dataLocale?: string;
  /** Query-language compatibility level. */
  compatibilityLevel?: "1.0" | "1.2";
  /**
   * Where job content (reference data, custom code) is stored. Set
   * `JobStorageAccount` together with `jobStorageAccount`.
   */
  contentStoragePolicy?: "SystemAccount" | "JobStorageAccount";
  /** Storage account for job content and checkpoints. */
  jobStorageAccount?: StreamingJobStorageAccount;
  /**
   * ARM ID of a Stream Analytics cluster to run the job on. If omitted,
   * the job runs in the shared multi-tenant environment.
   */
  clusterId?: string;
  /**
   * Give the job a system-assigned managed identity it can use to
   * authenticate to inputs and outputs (`authenticationMode: "Msi"`).
   */
  identity?: "SystemAssigned";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface StreamingJob extends Resource<
  "Azure.StreamAnalytics.StreamingJob",
  StreamingJobProps,
  {
    /** Name of the streaming job. */
    jobName: string;
    /** ARM resource ID of the job. */
    streamingJobId: string;
    /** Azure-assigned GUID of the job. */
    jobGuid: string | undefined;
    /** Resource group that holds the job. */
    resourceGroup: string;
    /** Location of the job. */
    location: string;
    /** Job type (`Cloud` or `Edge`). */
    jobType: string;
    /** Run state, e.g. `Created`, `Running`, `Stopped`. */
    jobState: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Stream Analytics streaming job — a real-time analytics pipeline
 * whose inputs, outputs, functions, and query are modelled as the child
 * resources `Input`, `Output`, `Function`, and `Transformation`.
 *
 * Alchemy creates and updates the job definition but never starts it; a
 * job is billed per streaming unit only while running, so a deployed,
 * stopped job costs nothing. Start it from the portal or the
 * `StartStreamingJob` API. A running job rejects definition changes, so
 * stop it before deploying updates.
 *
 * @see https://learn.microsoft.com/azure/stream-analytics/stream-analytics-introduction
 *
 * ### Creating a Streaming Job
 * **Example:** Cloud job with default policies
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("analytics");
 * const job = yield* Azure.StreamAnalytics.StreamingJob("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Job with a managed identity and event-ordering policies
 * ```typescript
 * const job = yield* Azure.StreamAnalytics.StreamingJob("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: "SystemAssigned",
 *   compatibilityLevel: "1.2",
 *   eventsOutOfOrderPolicy: "Drop",
 *   eventsOutOfOrderMaxDelayInSeconds: 10,
 *   outputErrorPolicy: "Drop",
 * });
 * ```
 *
 * ### Running on a Dedicated Cluster
 * **Example:** Job pinned to a Stream Analytics cluster
 * ```typescript
 * const cluster = yield* Azure.StreamAnalytics.Cluster("dedicated", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const job = yield* Azure.StreamAnalytics.StreamingJob("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   clusterId: cluster.clusterResourceId,
 * });
 * ```
 *
 * @resource
 */
export const StreamingJob = Resource<StreamingJob>(
  "Azure.StreamAnalytics.StreamingJob",
);

type ObservedJob = streamanalytics.GetStreamingJobResponse;

const toAttrs = (
  resourceGroup: string,
  name: string,
  job: ObservedJob,
): StreamingJob["Attributes"] => ({
  jobName: name,
  streamingJobId: job.id ?? "",
  jobGuid: job.properties?.jobId,
  resourceGroup,
  location: job.location ?? "",
  jobType: job.properties?.jobType ?? "Cloud",
  jobState: job.properties?.jobState,
  principalId: job.identity?.principalId,
  tags: userTags(job.tags),
});

export const StreamingJobProvider = () =>
  Provider.succeed(StreamingJob, {
    stables: ["jobName", "streamingJobId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* streamanalytics
        .ListStreamingJobs({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListStreamingJobs", page),
          ),
        );
      return (page.value ?? []).flatMap((job) => {
        const group = resourceGroupOf(job.id);
        return hasAnyAlchemyTag(job.tags) &&
          group !== undefined &&
          job.name !== undefined
          ? [toAttrs(group, job.name, job)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.jobName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        lower(news.jobType ?? "Cloud") !== lower(output.jobType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.jobName ?? olds?.name ?? (yield* createStreamAnalyticsName(id));
      const observed = yield* getStreamingJob(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.StreamAnalytics");
      const resourceGroup = news.resourceGroup;
      yield* checkResourceGroup(resourceGroup);
      const name =
        news.name ?? output?.jobName ?? (yield* createStreamAnalyticsName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const desired: streamanalytics.StreamingJobPropertiesInput = {
        sku: { name: news.sku ?? "Standard" },
        eventsOutOfOrderPolicy: news.eventsOutOfOrderPolicy,
        eventsOutOfOrderMaxDelayInSeconds:
          news.eventsOutOfOrderMaxDelayInSeconds,
        eventsLateArrivalMaxDelayInSeconds:
          news.eventsLateArrivalMaxDelayInSeconds,
        outputErrorPolicy: news.outputErrorPolicy,
        dataLocale: news.dataLocale,
        compatibilityLevel: news.compatibilityLevel,
        contentStoragePolicy: news.contentStoragePolicy,
        jobStorageAccount: news.jobStorageAccount,
        cluster:
          news.clusterId === undefined ? undefined : { id: news.clusterId },
      };
      const identity =
        news.identity === undefined ? undefined : { type: news.identity };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        jobName: name,
      };
      const get = getStreamingJob(subscriptionId, resourceGroup, name);
      const label = `stream analytics job ${name}`;
      const waitReady = waitForProvisioned(
        label,
        get,
        (job) => job.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT never carries `outputStartMode`, which would start
      // the job (and its billing) right away.
      if (observed === undefined) {
        yield* streamanalytics.StreamingJobsCreateOrReplace({
          ...where,
          location,
          tags,
          identity,
          properties: { ...desired, jobType: news.jobType ?? "Cloud" },
        });
      }
      observed = yield* waitReady;

      // Sync policies, identity, and tags against the observed job; PATCH
      // only the delta. A changed storage-account key is invisible on GET,
      // so it is detected against the previous props.
      const props = (observed.properties ?? {}) as Record<string, unknown>;
      const changed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(desired)) {
        if (value !== undefined && !matchesObserved(value, props[key])) {
          changed[key] = value;
        }
      }
      if (
        news.jobStorageAccount?.accountKey !== undefined &&
        olds !== undefined &&
        olds.jobStorageAccount?.accountKey !== news.jobStorageAccount.accountKey
      ) {
        changed.jobStorageAccount = news.jobStorageAccount;
      }
      const identityChanged =
        identity !== undefined &&
        lower(observed.identity?.type) !== lower(identity.type);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || identityChanged || tagsChanged) {
        yield* streamanalytics.UpdateStreamingJob({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties:
            Object.keys(changed).length > 0
              ? (changed as streamanalytics.StreamingJobPropertiesInput)
              : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Deleting a running job stops it first.
      yield* ignoreNotFound(
        streamanalytics.DeleteStreamingJob({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          jobName: output.jobName,
        }),
      );
      yield* waitUntilGone(
        `stream analytics job ${output.jobName}`,
        getStreamingJob(subscriptionId, output.resourceGroup, output.jobName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
