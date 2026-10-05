import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Output from "../../Output.ts";
import {
  azureDataPlaneRequest,
  bindAzureHost,
  envSuffix,
  xmlElements,
  xmlEncode,
  xmlField,
} from "../Binding.ts";
import type { Queue } from "./Queue.ts";
import type {
  ReceiveStorageQueueClient,
  StorageQueueMessage,
  StorageQueueReceiveOptions,
} from "./QueueReceive.ts";
import type {
  SendStorageQueueClient,
  StorageQueueSendOptions,
} from "./QueueSend.ts";

/**
 * Shared HTTP scaffolding for storage queue bindings. NOT exported from
 * `index.ts`.
 */

const STORAGE_SCOPE = "https://storage.azure.com/.default";
const STORAGE_VERSION = "2023-11-03";

export interface StorageQueueHttpContext {
  readonly tag: string;
  readonly http: HttpClient.HttpClient;
  /** `https://{account}.queue.core.windows.net/{queue}`, resolved per call. */
  readonly queueUrl: Effect.Effect<string>;
}

const send = (
  ctx: StorageQueueHttpContext,
  request: HttpClientRequest.HttpClientRequest,
  allow?: readonly number[],
) =>
  azureDataPlaneRequest(
    ctx.http,
    STORAGE_SCOPE,
    request.pipe(HttpClientRequest.setHeader("x-ms-version", STORAGE_VERSION)),
    { allow },
  );

export const makeSendStorageQueueClient = (ctx: StorageQueueHttpContext) =>
  ({
    send: Effect.fn(`${ctx.tag}.send`)(function* (
      message: string,
      options?: StorageQueueSendOptions,
    ) {
      const base = yield* ctx.queueUrl;
      const res = yield* send(
        ctx,
        HttpClientRequest.post(`${base}/messages`).pipe(
          HttpClientRequest.setUrlParams({
            ...(options?.visibilityTimeoutSeconds !== undefined
              ? { visibilitytimeout: String(options.visibilityTimeoutSeconds) }
              : {}),
            ...(options?.timeToLiveSeconds !== undefined
              ? { messagettl: String(options.timeToLiveSeconds) }
              : {}),
          }),
          HttpClientRequest.bodyText(
            `<QueueMessage><MessageText>${xmlEncode(message)}</MessageText></QueueMessage>`,
            "application/xml",
          ),
        ),
      );
      return {
        messageId: xmlField(res.text, "MessageId"),
        popReceipt: xmlField(res.text, "PopReceipt"),
        insertionTime: xmlField(res.text, "InsertionTime"),
      };
    }),
  }) satisfies SendStorageQueueClient;

export const makeReceiveStorageQueueClient = (ctx: StorageQueueHttpContext) =>
  ({
    receive: Effect.fn(`${ctx.tag}.receive`)(function* (
      options?: StorageQueueReceiveOptions,
    ) {
      const base = yield* ctx.queueUrl;
      const res = yield* send(
        ctx,
        HttpClientRequest.get(`${base}/messages`).pipe(
          HttpClientRequest.setUrlParams({
            numofmessages: String(options?.maxMessages ?? 1),
            ...(options?.visibilityTimeoutSeconds !== undefined
              ? { visibilitytimeout: String(options.visibilityTimeoutSeconds) }
              : {}),
          }),
        ),
      );
      return xmlElements(res.text, "QueueMessage").map(
        (xml): StorageQueueMessage => ({
          messageId: xmlField(xml, "MessageId") ?? "",
          popReceipt: xmlField(xml, "PopReceipt") ?? "",
          text: xmlField(xml, "MessageText") ?? "",
          dequeueCount: Number(xmlField(xml, "DequeueCount") ?? 0),
          insertionTime: xmlField(xml, "InsertionTime"),
        }),
      );
    }),
    delete: Effect.fn(`${ctx.tag}.delete`)(function* (
      message: Pick<StorageQueueMessage, "messageId" | "popReceipt">,
    ) {
      const base = yield* ctx.queueUrl;
      yield* send(
        ctx,
        HttpClientRequest.delete(
          `${base}/messages/${encodeURIComponent(message.messageId)}`,
        ).pipe(
          HttpClientRequest.setUrlParams({ popreceipt: message.popReceipt }),
        ),
        [404],
      );
    }),
  }) satisfies ReceiveStorageQueueClient;

/**
 * Build the impl Effect for a storage queue capability: grant `role` on
 * the queue to the host identity, register env vars, return the client.
 */
export const makeStorageQueueHttpBinding = <Client>(options: {
  tag: string;
  role: string;
  makeClient: (ctx: StorageQueueHttpContext) => Client;
}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* (queue: Queue) {
      const suffix = envSuffix(queue.LogicalId);
      yield* bindAzureHost({
        tag: options.tag,
        resource: queue,
        env: {
          [`AZURE_STORAGE_ACCOUNT_${suffix}`]: queue.storageAccount,
          [`AZURE_STORAGE_QUEUE_${suffix}`]: queue.queueName,
        },
        roleAssignments: [
          { roleDefinitionId: options.role, scope: queue.queueId },
        ],
      });
      const url =
        yield* Output.interpolate`https://${queue.storageAccount}.queue.core.windows.net/${queue.queueName}`;
      return options.makeClient({
        tag: `${options.tag}(${queue.LogicalId})`,
        http,
        queueUrl: url,
      });
    });
  });
