import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Layer from "effect/Layer";
import { GetQueueServiceProperties } from "./GetQueueServiceProperties.ts";
import { makeQueueServiceOperationBinding, QueueGrants } from "./StorageQueueHttp.ts";

/**
 * Implementation of {@link GetQueueServiceProperties} over the distilled `storage-queue`
 * `GetServiceProperties` operation. Assigns a custom role with only the `queueServices/read` action
 * on the storage account.
 *
 * @layer
 * @provides Azure.Storage.GetQueueServiceProperties
 */
export const GetQueueServicePropertiesHttp = Layer.effect(
  GetQueueServiceProperties,
  makeQueueServiceOperationBinding({
    tag: "Azure.Storage.GetQueueServiceProperties",
    operation: queues.GetServiceProperties,
    grant: QueueGrants.readService,
  }),
);
