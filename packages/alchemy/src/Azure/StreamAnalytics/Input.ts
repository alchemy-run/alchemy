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

export interface InputProps {
  /** Resource group of the streaming job. Changing it replaces the input. */
  resourceGroup: string;
  /** Name of the streaming job. Changing it replaces the input. */
  streamingJob: string;
  /**
   * Input name, referenced from the job's query (`FROM [name]`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the input.
   */
  name?: string;
  /**
   * Whether the input is a stream of events or slowly changing reference
   * data. Changing it replaces the input.
   * @default "Stream"
   */
  type?: "Stream" | "Reference";
  /**
   * Data source, e.g. `{ type: "Microsoft.Storage/Blob", properties: {
   * storageAccounts: [{ accountName }], container, pathPattern,
   * authenticationMode: "Msi" } }` or `{ type: "Microsoft.ServiceBus/EventHub",
   * properties: { serviceBusNamespace, eventHubName, ... } }`. Keys and
   * passwords are write-only in Azure; their changes are detected against
   * the previous props.
   */
  datasource: TypedDocument;
  /**
   * How events are serialized, e.g. `{ type: "Json", properties: {
   * encoding: "UTF8" } }` or `{ type: "Csv", properties: { fieldDelimiter:
   * ",", encoding: "UTF8" } }`.
   */
  serialization: TypedDocument;
  /**
   * Compression of the incoming data.
   * @default Azure's default (`None`)
   */
  compression?: "None" | "GZip" | "Deflate";
  /** Key in the input data used to partition it. */
  partitionKey?: string;
}

export interface Input extends Resource<
  "Azure.StreamAnalytics.Input",
  InputProps,
  {
    /** Name of the input. */
    inputName: string;
    /** Name of the streaming job. */
    streamingJob: string;
    /** Resource group of the streaming job. */
    resourceGroup: string;
    /** ARM resource ID of the input. */
    inputId: string;
    /** Input type (`Stream` or `Reference`). */
    type: string;
    /** Entity tag of the current input definition. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An input of an Azure Stream Analytics streaming job — the stream (Event
 * Hubs, IoT Hub, Blob storage) or reference data the job's query reads
 * `FROM`.
 *
 * Inputs carry no tags; Alchemy treats one as owned when its streaming job
 * carries this stack's and stage's ownership tags. Changes are rejected
 * while the job is running.
 *
 * @see https://learn.microsoft.com/azure/stream-analytics/stream-analytics-add-inputs
 *
 * ### Stream Inputs
 * **Example:** Blob storage stream read with the job's managed identity
 * ```typescript
 * const job = yield* Azure.StreamAnalytics.StreamingJob("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: "SystemAssigned",
 * });
 * const events = yield* Azure.StreamAnalytics.Input("events", {
 *   resourceGroup: group.resourceGroupName,
 *   streamingJob: job.jobName,
 *   name: "events",
 *   datasource: {
 *     type: "Microsoft.Storage/Blob",
 *     properties: {
 *       storageAccounts: [{ accountName: account.storageAccountName }],
 *       container: "incoming",
 *       pathPattern: "{date}/{time}",
 *       dateFormat: "yyyy/MM/dd",
 *       timeFormat: "HH",
 *       authenticationMode: "Msi",
 *     },
 *   },
 *   serialization: { type: "Json", properties: { encoding: "UTF8" } },
 * });
 * ```
 *
 * **Example:** Event Hubs stream
 * ```typescript
 * const events = yield* Azure.StreamAnalytics.Input("events", {
 *   resourceGroup: group.resourceGroupName,
 *   streamingJob: job.jobName,
 *   datasource: {
 *     type: "Microsoft.ServiceBus/EventHub",
 *     properties: {
 *       serviceBusNamespace: namespace.namespaceName,
 *       eventHubName: hub.eventHubName,
 *       consumerGroupName: "$Default",
 *       authenticationMode: "Msi",
 *     },
 *   },
 *   serialization: { type: "Json", properties: { encoding: "UTF8" } },
 * });
 * ```
 *
 * ### Reference Inputs
 * **Example:** CSV reference data from Blob storage
 * ```typescript
 * const devices = yield* Azure.StreamAnalytics.Input("devices", {
 *   resourceGroup: group.resourceGroupName,
 *   streamingJob: job.jobName,
 *   type: "Reference",
 *   datasource: {
 *     type: "Microsoft.Storage/Blob",
 *     properties: {
 *       storageAccounts: [{ accountName: account.storageAccountName }],
 *       container: "reference",
 *       pathPattern: "devices.csv",
 *       authenticationMode: "Msi",
 *     },
 *   },
 *   serialization: {
 *     type: "Csv",
 *     properties: { fieldDelimiter: ",", encoding: "UTF8" },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Input = Resource<Input>("Azure.StreamAnalytics.Input");

const getInput = (
  subscriptionId: string,
  resourceGroupName: string,
  jobName: string,
  inputName: string,
) =>
  orUndefinedIfNotFound(
    streamanalytics.GetInput({
      subscriptionId,
      resourceGroupName,
      jobName,
      inputName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  streamingJob: string,
  name: string,
  input: streamanalytics.GetInputResponse,
): Input["Attributes"] => ({
  inputName: name,
  streamingJob,
  resourceGroup,
  inputId: input.id ?? "",
  type: input.properties?.type ?? "Stream",
  etag: input.properties?.etag,
});

export const InputProvider = () =>
  Provider.succeed(Input, {
    stables: ["inputName", "streamingJob", "resourceGroup", "inputId"],

    // Inputs live inside a streaming job; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.streamingJob) !== lower(output.streamingJob) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.inputName)) ||
        lower(news.type ?? "Stream") !== lower(output.type)
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
        output?.inputName ??
        olds?.name ??
        (yield* createStreamAnalyticsName(id));
      const observed = yield* getInput(
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
        output?.inputName ??
        (yield* createStreamAnalyticsName(id));
      const properties: streamanalytics.InputPropertiesInput = {
        type: news.type ?? "Stream",
        datasource: news.datasource,
        serialization: news.serialization,
        compression:
          news.compression === undefined
            ? undefined
            : { type: news.compression },
        partitionKey: news.partitionKey,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        jobName: streamingJob,
        inputName: name,
      };
      const get = getInput(subscriptionId, resourceGroup, streamingJob, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync: PATCH the full desired definition when the
      // observed one drifted, or when a write-only secret in the data source
      // changed since the last deploy.
      if (observed === undefined) {
        yield* streamanalytics.InputsCreateOrReplace({ ...where, properties });
      } else if (
        !matchesObserved(properties, observed.properties) ||
        (olds !== undefined &&
          canonical(olds.datasource) !== canonical(news.datasource))
      ) {
        yield* streamanalytics.UpdateInput({ ...where, properties });
      }

      const fresh = yield* waitForProvisioned(
        `stream analytics input ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, streamingJob, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        streamanalytics.DeleteInput({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          jobName: output.streamingJob,
          inputName: output.inputName,
        }),
      );
      yield* waitUntilGone(
        `stream analytics input ${output.inputName}`,
        getInput(
          subscriptionId,
          output.resourceGroup,
          output.streamingJob,
          output.inputName,
        ),
      );
    }),
  });
