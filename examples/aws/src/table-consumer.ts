import { $ } from "alchemy-effect";
import * as Lambda from "alchemy-effect/aws/lambda";
import * as Effect from "effect/Effect";
import { SingleTable } from "./api.ts";

/**
 * Example of consuming DynamoDB table changes using Lambda.consumeTable.
 *
 * This Lambda function is automatically triggered whenever items in the
 * SingleTable are created, updated, or deleted. The event source mapping
 * and DynamoDB Streams are automatically configured.
 */
export class TableConsumer extends Lambda.consumeTable("TableConsumer", {
  table: SingleTable,
  // Stream view type determines what data is sent to the Lambda
  // - NEW_AND_OLD_IMAGES: Both new and old item images (default)
  // - NEW_IMAGE: Only the new item image
  // - OLD_IMAGE: Only the old item image
  // - KEYS_ONLY: Only the key attributes
  streamViewType: "NEW_AND_OLD_IMAGES",
  // Batch settings for the event source mapping
  batchSize: 100,
  maxBatchingWindow: 5,
  // Process the stream events
  handle: Effect.fn(function* (event) {
    for (const record of event.Records) {
      console.log("Event type:", record.eventName); // INSERT, MODIFY, REMOVE

      if (record.eventName === "INSERT") {
        console.log("New item created:", record.dynamodb?.NewImage);
      } else if (record.eventName === "MODIFY") {
        console.log("Item updated:");
        console.log("  Old:", record.dynamodb?.OldImage);
        console.log("  New:", record.dynamodb?.NewImage);
      } else if (record.eventName === "REMOVE") {
        console.log("Item deleted:", record.dynamodb?.OldImage);
      }
    }

    // Return batch item failures for partial batch responses
    // If any records failed processing, return their sequence numbers
    return {
      batchItemFailures: [],
    };
  }),
})({
  main: import.meta.filename,
  bindings: $(),
  memory: 128,
}) {}

// Export the handler for Lambda runtime
export default TableConsumer.handler.pipe(Lambda.toHandler);
