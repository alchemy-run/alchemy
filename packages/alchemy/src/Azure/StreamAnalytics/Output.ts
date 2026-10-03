import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
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
  canonical,
  createStreamAnalyticsName,
  jobOwnedByStage,
  lower,
  matchesObserved,
  type TypedDocument,
  checkResourceGroup,
} from "./Common.ts";

export interface OutputProps {
  /** Resource group of the streaming job. Changing it replaces the output. */
  resourceGroup: string;
  /** Name of the streaming job. Changing it replaces the output. */
  streamingJob: string;
  /**
   * Output name, referenced from the job's query (`INTO [name]`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the output.
   */
  name?: string;
  /**
   * Data sink, e.g. `{ type: "Microsoft.Storage/Blob", properties: {
   * storageAccounts: [{ accountName }], container, pathPattern,
   * authenticationMode: "Msi" } }`, `Microsoft.ServiceBus/EventHub`,
   * `Microsoft.Storage/DocumentDB`, `Microsoft.Sql/Server/Database`, ...
   * Keys and passwords are write-only in Azure; their changes are detected
   * against the previous props.
   */
  datasource: TypedDocument;
  /**
   * How events are serialized, e.g. `{ type: "Json", properties: {
   * encoding: "UTF8", format: "LineSeparated" } }`. Required by sinks that
   * write files or messages (Blob, Event Hubs, Service Bus).
   */
  serialization?: TypedDocument;
  /**
   * Maximum time window a batch may span, e.g. `00:05:00` (Blob and Data
   * Lake outputs).
   */
  timeWindow?: string;
  /** Minimum number of rows per batch (Blob and Data Lake outputs). */
  sizeWindow?: number;
}

export interface Output extends Resource<
  "Azure.StreamAnalytics.Output",
  OutputProps,
  {
    /** Name of the output. */
    outputName: string;
    /** Name of the streaming job. */
    streamingJob: string;
    /** Resource group of the streaming job. */
    resourceGroup: string;
    /** ARM resource ID of the output. */
    outputId: string;
    /** Data source type, e.g. `Microsoft.Storage/Blob`. */
    datasourceType: string | undefined;
    /** Entity tag of the current output definition. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An output of an Azure Stream Analytics streaming job — the sink (Blob
 * storage, Event Hubs, Service Bus, Cosmos DB, SQL, ...) the job's query
 * writes `INTO`.
 *
 * Outputs carry no tags; Alchemy treats one as owned when its streaming
 * job carries this stack's and stage's ownership tags. Changes are rejected
 * while the job is running.
 *
 * @see https://learn.microsoft.com/azure/stream-analytics/stream-analytics-define-outputs
 *
 * ### Writing to Storage
 * **Example:** JSON lines to Blob storage with the job's managed identity
 * ```typescript
 * const archive = yield* Azure.StreamAnalytics.Output("archive", {
 *   resourceGroup: group.resourceGroupName,
 *   streamingJob: job.jobName,
 *   name: "archive",
 *   datasource: {
 *     type: "Microsoft.Storage/Blob",
 *     properties: {
 *       storageAccounts: [{ accountName: account.storageAccountName }],
 *       container: "archive",
 *       pathPattern: "{date}",
 *       dateFormat: "yyyy/MM/dd",
 *       authenticationMode: "Msi",
 *     },
 *   },
 *   serialization: {
 *     type: "Json",
 *     properties: { encoding: "UTF8", format: "LineSeparated" },
 *   },
 * });
 * ```
 *
 * ### Writing to Messaging
 * **Example:** Event Hubs sink
 * ```typescript
 * const alerts = yield* Azure.StreamAnalytics.Output("alerts", {
 *   resourceGroup: group.resourceGroupName,
 *   streamingJob: job.jobName,
 *   datasource: {
 *     type: "Microsoft.ServiceBus/EventHub",
 *     properties: {
 *       serviceBusNamespace: namespace.namespaceName,
 *       eventHubName: hub.eventHubName,
 *       authenticationMode: "Msi",
 *     },
 *   },
 *   serialization: { type: "Json", properties: { encoding: "UTF8" } },
 * });
 * ```
 *
 * @resource
 */
export const Output = Resource<Output>("Azure.StreamAnalytics.Output");

const getOutput = (
  subscriptionId: string,
  resourceGroupName: string,
  jobName: string,
  outputName: string,
) =>
  orUndefinedIfNotFound(
    streamanalytics.GetOutput({
      subscriptionId,
      resourceGroupName,
      jobName,
      outputName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  streamingJob: string,
  name: string,
  output: streamanalytics.GetOutputResponse,
): Output["Attributes"] => ({
  outputName: name,
  streamingJob,
  resourceGroup,
  outputId: output.id ?? "",
  datasourceType: output.properties?.datasource?.type,
  etag: output.properties?.etag,
});

export const OutputProvider = () =>
  Provider.succeed(Output, {
    stables: ["outputName", "streamingJob", "resourceGroup", "outputId"],

    // Outputs live inside a streaming job; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.streamingJob) !== lower(output.streamingJob) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.outputName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const streamingJob = output?.streamingJob ?? olds?.streamingJob;
      if (resourceGroup === undefined || streamingJob === undefined) {
        return undefined;
      }
      const name =
        output?.outputName ??
        olds?.name ??
        (yield* createStreamAnalyticsName(id));
      const observed = yield* getOutput(
        subscriptionId,
        resourceGroup,
        streamingJob,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, streamingJob, name, observed);
      return (yield* jobOwnedByStage(
        subscriptionId,
        resourceGroup,
        streamingJob,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StreamAnalytics");
      const { resourceGroup, streamingJob } = news;
      yield* checkResourceGroup(resourceGroup);
      const name =
        news.name ??
        output?.outputName ??
        (yield* createStreamAnalyticsName(id));
      const properties: streamanalytics.OutputPropertiesInput = {
        datasource: news.datasource,
        serialization: news.serialization,
        timeWindow: news.timeWindow,
        sizeWindow: news.sizeWindow,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        jobName: streamingJob,
        outputName: name,
      };
      const get = getOutput(subscriptionId, resourceGroup, streamingJob, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync: PATCH the full desired definition when the
      // observed one drifted, or when a write-only secret in the data sink
      // changed since the last deploy.
      if (observed === undefined) {
        yield* streamanalytics.OutputsCreateOrReplace({ ...where, properties });
      } else if (
        !matchesObserved(properties, observed.properties) ||
        (olds !== undefined &&
          canonical(olds.datasource) !== canonical(news.datasource))
      ) {
        yield* streamanalytics.UpdateOutput({ ...where, properties });
      }

      const fresh = yield* waitForProvisioned(
        `stream analytics output ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, streamingJob, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        streamanalytics.DeleteOutput({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          jobName: output.streamingJob,
          outputName: output.outputName,
        }),
      );
      yield* waitUntilGone(
        `stream analytics output ${output.outputName}`,
        getOutput(
          subscriptionId,
          output.resourceGroup,
          output.streamingJob,
          output.outputName,
        ),
      );
    }),
  });
