<!-- Docs for the generated AWS.SQS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelMessageMoveTask

Runtime binding for `sqs:CancelMessageMoveTask` (dead-letter queue
redrive).

Bind this operation to the dead-letter {@link Queue} whose move task
should be cancellable. Cancellation only stops messages that have not been
moved yet; a task that already finished fails with the typed
`ResourceNotFoundException`. The binding grants the host function
`sqs:CancelMessageMoveTask` on the queue. Provide the
`CancelMessageMoveTaskHttp` layer on the Function to implement the
binding.
### Dead-Letter Queue Redrive
**Example:** Cancel a Running Redrive
```typescript
// init (provide SQS.CancelMessageMoveTaskHttp on the Function)
const cancelMessageMoveTask = yield* SQS.CancelMessageMoveTask(dlq);

// runtime
yield* cancelMessageMoveTask({ TaskHandle: taskHandle });
```

@binding

## ChangeMessageVisibility

Runtime binding for `sqs:ChangeMessageVisibility`.

Bind this operation to a {@link Queue} inside a function runtime to extend
or shrink the visibility timeout of an in-flight message — e.g. extend it
while a slow job is still processing, or set it to `0` to release the
message back to the queue immediately. The binding grants the host
function `sqs:ChangeMessageVisibility` on the queue. Provide the
`ChangeMessageVisibilityHttp` layer on the Function to implement the
binding.
### Changing Message Visibility
**Example:** Release a Message Back to the Queue
```typescript
// init (provide SQS.ChangeMessageVisibilityHttp on the Function)
const changeMessageVisibility = yield* SQS.ChangeMessageVisibility(queue);

// runtime: make the message immediately receivable again
yield* changeMessageVisibility({
  ReceiptHandle: message.ReceiptHandle!,
  VisibilityTimeout: 0,
});
```

**Example:** Extend Processing Time for a Slow Job
```typescript
yield* changeMessageVisibility({
  ReceiptHandle: message.ReceiptHandle!,
  VisibilityTimeout: 600,
});
```

@binding

## ChangeMessageVisibilityBatch

Runtime binding for `sqs:ChangeMessageVisibilityBatch`.

Bind this operation to a {@link Queue} inside a function runtime to change
the visibility timeout of up to 10 in-flight messages per call with
per-entry success/failure results. The binding grants the host function
`sqs:ChangeMessageVisibility` on the queue. Provide the
`ChangeMessageVisibilityBatchHttp` layer on the Function to implement the
binding.
### Changing Message Visibility
**Example:** Release a Batch of Messages Back to the Queue
```typescript
// init (provide SQS.ChangeMessageVisibilityBatchHttp on the Function)
const changeMessageVisibilityBatch =
  yield* SQS.ChangeMessageVisibilityBatch(queue);

// runtime
const result = yield* changeMessageVisibilityBatch({
  Entries: messages.map((message, index) => ({
    Id: `${index}`,
    ReceiptHandle: message.ReceiptHandle!,
    VisibilityTimeout: 0,
  })),
});
// result.Successful / result.Failed
```

@binding

## DeleteMessage

Runtime binding for `sqs:DeleteMessage`.

Bind this operation to a {@link Queue} inside a function runtime to delete
a message after it has been received and processed. The binding grants the
host function `sqs:DeleteMessage` on the queue. Provide the
`DeleteMessageHttp` layer on the Function to implement the binding.
### Deleting Messages
**Example:** Delete a Processed Message
```typescript
// init (provide SQS.DeleteMessageHttp on the Function)
const deleteMessage = yield* SQS.DeleteMessage(queue);

// runtime: acknowledge a message received via ReceiveMessage
const result = yield* receiveMessage({ MaxNumberOfMessages: 1 });
const [message] = result.Messages ?? [];
if (message?.ReceiptHandle) {
  yield* deleteMessage({ ReceiptHandle: message.ReceiptHandle });
}
```

@binding

## DeleteMessageBatch

Runtime binding for `sqs:DeleteMessageBatch`.

Bind this operation to a {@link Queue} inside a function runtime to delete
up to 10 received messages per call with per-entry success/failure results.
The binding grants the host function `sqs:DeleteMessage` on the queue.
Provide the `DeleteMessageBatchHttp` layer on the Function to implement the
binding.
### Deleting Message Batches
**Example:** Delete a Batch of Processed Messages
```typescript
// init (provide SQS.DeleteMessageBatchHttp on the Function)
const deleteMessageBatch = yield* SQS.DeleteMessageBatch(queue);

// runtime: acknowledge messages received via ReceiveMessage
const result = yield* deleteMessageBatch({
  Entries: messages.map((message, index) => ({
    Id: `${index}`,
    ReceiptHandle: message.ReceiptHandle!,
  })),
});
// result.Successful / result.Failed
```

@binding

## GetQueueAttributes

Runtime binding for `sqs:GetQueueAttributes`.

Bind this operation to a {@link Queue} inside a function runtime to read
live queue attributes — e.g. `ApproximateNumberOfMessages` for queue-depth
monitoring or backpressure decisions. The binding grants the host function
`sqs:GetQueueAttributes` on the queue. Provide the
`GetQueueAttributesHttp` layer on the Function to implement the binding.
### Reading Queue Attributes
**Example:** Monitor Queue Depth
```typescript
// init (provide SQS.GetQueueAttributesHttp on the Function)
const getQueueAttributes = yield* SQS.GetQueueAttributes(queue);

// runtime
const result = yield* getQueueAttributes({
  AttributeNames: ["ApproximateNumberOfMessages"],
});
const depth = Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
```

@binding

## ListDeadLetterSourceQueues

Runtime binding for `sqs:ListDeadLetterSourceQueues`.

Bind this operation to a dead-letter {@link Queue} inside a function
runtime to enumerate the source queues whose `redrivePolicy` targets it.
The binding grants the host function `sqs:ListDeadLetterSourceQueues` on
the queue. Provide the `ListDeadLetterSourceQueuesHttp` layer on the
Function to implement the binding.
### Dead-Letter Queue Redrive
**Example:** List Source Queues of a Dead-Letter Queue
```typescript
// init (provide SQS.ListDeadLetterSourceQueuesHttp on the Function)
const listDeadLetterSourceQueues =
  yield* SQS.ListDeadLetterSourceQueues(dlq);

// runtime
const result = yield* listDeadLetterSourceQueues();
// result.queueUrls: URLs of every queue using `dlq` as its DLQ
```

@binding

## ListMessageMoveTasks

Runtime binding for `sqs:ListMessageMoveTasks` (dead-letter queue
redrive).

Bind this operation to a dead-letter {@link Queue} inside a function
runtime to inspect the most recent message move tasks (up to 10) whose
source is that queue — including their status, progress counters, and
`TaskHandle` for cancellation. The binding grants the host function
`sqs:ListMessageMoveTasks` on the queue. Provide the
`ListMessageMoveTasksHttp` layer on the Function to implement the binding.
### Dead-Letter Queue Redrive
**Example:** Inspect Redrive Progress
```typescript
// init (provide SQS.ListMessageMoveTasksHttp on the Function)
const listMessageMoveTasks = yield* SQS.ListMessageMoveTasks(dlq);

// runtime
const result = yield* listMessageMoveTasks();
for (const task of result.Results ?? []) {
  // task.Status, task.ApproximateNumberOfMessagesMoved, task.TaskHandle
}
```

@binding

## PurgeQueue

Runtime binding for `sqs:PurgeQueue`.

Bind this operation to a {@link Queue} inside a function runtime to delete
every message in the queue in one call. The purge takes up to 60 seconds
to complete, and only one purge per queue is allowed every 60 seconds
(a second call fails with the typed `PurgeQueueInProgress` error). The
binding grants the host function `sqs:PurgeQueue` on the queue. Provide
the `PurgeQueueHttp` layer on the Function to implement the binding.
### Purging a Queue
**Example:** Purge All Messages
```typescript
// init (provide SQS.PurgeQueueHttp on the Function)
const purgeQueue = yield* SQS.PurgeQueue(queue);

// runtime: drop everything currently in the queue
yield* purgeQueue();
```

@binding

## ReceiveMessage

Runtime binding for `sqs:ReceiveMessage`.

Bind this operation to a {@link Queue} inside a function runtime to poll
messages on demand. The binding grants the host function
`sqs:ReceiveMessage` on the queue. Provide the `ReceiveMessageHttp` layer
on the Function to implement the binding.

For push-based consumption (Lambda event-source mapping) use
{@link consumeQueueMessages} instead of polling manually.
### Receiving Messages
**Example:** Poll for Messages
```typescript
// init (provide SQS.ReceiveMessageHttp on the Function)
const receiveMessage = yield* SQS.ReceiveMessage(queue);

// runtime: long-poll for up to 10 messages
const result = yield* receiveMessage({
  MaxNumberOfMessages: 10,
  WaitTimeSeconds: 2,
});
for (const message of result.Messages ?? []) {
  // message.Body, message.ReceiptHandle
}
```

@binding

## SendMessage

Runtime binding for `sqs:SendMessage`.

Bind this operation to a {@link Queue} inside a function runtime to get a
callable that automatically injects the `QueueUrl`. The binding grants the
host function `sqs:SendMessage` on the queue. Provide the `SendMessageHttp`
layer on the Function to implement the binding.
### Sending Messages
**Example:** Send a Message from a Lambda Function
```typescript
export class ApiFunction extends Lambda.Function<Lambda.Function>()(
  "ApiFunction",
) {}

export default ApiFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("Jobs");

    // init: bind the operation to the queue (grants sqs:SendMessage)
    const sendMessage = yield* SQS.SendMessage(queue);

    return {
      fetch: Effect.gen(function* () {
        // runtime: QueueUrl is injected automatically
        const result = yield* sendMessage({ MessageBody: "hello" });
        return yield* HttpServerResponse.json({
          messageId: result.MessageId,
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(SQS.SendMessageHttp)),
);
```

**Example:** Delay Delivery
```typescript
yield* sendMessage({ MessageBody: "process later", DelaySeconds: 60 });
```

@binding

## SendMessageBatch

Runtime binding for `sqs:SendMessageBatch`.

Bind this operation to a {@link Queue} inside a function runtime to send up
to 10 messages per call with per-entry success/failure results. The binding
grants the host function `sqs:SendMessage` on the queue. Provide the
`SendMessageBatchHttp` layer on the Function to implement the binding.

For an unbounded stream of messages with automatic batching and bounded
retry of transient per-entry failures, prefer {@link QueueSink}.
### Sending Message Batches
**Example:** Send a Batch of Messages
```typescript
// init (provide SQS.SendMessageBatchHttp on the Function)
const sendMessageBatch = yield* SQS.SendMessageBatch(queue);

// runtime
const result = yield* sendMessageBatch({
  Entries: messages.map((body, index) => ({
    Id: `${index}`,
    MessageBody: body,
  })),
});
// result.Successful / result.Failed
```

@binding
