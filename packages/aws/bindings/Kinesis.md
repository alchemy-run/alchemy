<!-- Docs for the generated AWS.Kinesis bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeAccountSettings

Runtime binding for `kinesis:DescribeAccountSettings`.

An account-level operation (no stream argument) that reports the account's
Kinesis settings, such as on-demand stream count quotas. Provide the
implementation with `Effect.provide(AWS.Kinesis.DescribeAccountSettingsHttp)`.
### Account Settings
**Example:** Read the Account's Kinesis Settings
```typescript
// init — account-level binding takes no resource
const describeAccountSettings = yield* AWS.Kinesis.DescribeAccountSettings();

// runtime
const settings = yield* describeAccountSettings();
```

@binding

## DescribeLimits

Runtime binding for `kinesis:DescribeLimits`.

An account-level operation (no stream argument) that reports shard quotas
and current usage for the region. Provide the implementation with
`Effect.provide(AWS.Kinesis.DescribeLimitsHttp)`.
### Account Settings
**Example:** Check Shard Quota Headroom
```typescript
// init — account-level binding takes no resource
const describeLimits = yield* AWS.Kinesis.DescribeLimits();

// runtime
const limits = yield* describeLimits();
const headroom = (limits.ShardLimit ?? 0) - (limits.OpenShardCount ?? 0);
```

@binding

## DescribeStream

Runtime binding for `kinesis:DescribeStream`.

Bind this operation to a `Stream` to read its full description, including
the shard map — the stream name is injected automatically. For status and
counts without the shard list, prefer `AWS.Kinesis.DescribeStreamSummary`.
Provide the implementation with
`Effect.provide(AWS.Kinesis.DescribeStreamHttp)`.
### Inspecting Streams
**Example:** Describe the Bound Stream
```typescript
// init
const describeStream = yield* AWS.Kinesis.DescribeStream(stream);

// runtime
const result = yield* describeStream();
const status = result.StreamDescription.StreamStatus;
const shards = result.StreamDescription.Shards;
```

@binding

## DescribeStreamConsumer

Runtime binding for `kinesis:DescribeStreamConsumer`.

Bind this operation to a `StreamConsumer` to read the enhanced fan-out
consumer's status and ARN — the consumer ARN is injected automatically.
Provide the implementation with
`Effect.provide(AWS.Kinesis.DescribeStreamConsumerHttp)`.
### Enhanced Fan-Out
**Example:** Describe a Registered Consumer
```typescript
const consumer = yield* AWS.Kinesis.StreamConsumer("Analytics", {
  streamArn: stream.streamArn,
});
// init
const describeStreamConsumer =
  yield* AWS.Kinesis.DescribeStreamConsumer(consumer);

// runtime
const result = yield* describeStreamConsumer();
const status = result.ConsumerDescription.ConsumerStatus;
```

@binding

## DescribeStreamSummary

Runtime binding for `kinesis:DescribeStreamSummary`.

Bind this operation to a `Stream` to read its status, mode, retention,
encryption, and open shard count without paginating the full shard map.
Provide the implementation with
`Effect.provide(AWS.Kinesis.DescribeStreamSummaryHttp)`.
### Inspecting Streams
**Example:** Read the Stream Summary
```typescript
// init
const describeStreamSummary = yield* AWS.Kinesis.DescribeStreamSummary(stream);

// runtime
const result = yield* describeStreamSummary();
const summary = result.StreamDescriptionSummary;
yield* Effect.log(`${summary.StreamStatus}: ${summary.OpenShardCount} shards`);
```

@binding

## GetRecords

Runtime binding for `kinesis:GetRecords`.

Bind this operation to a `Stream` to read records from a shard using an
iterator obtained via `AWS.Kinesis.GetShardIterator`. Provide the
implementation with `Effect.provide(AWS.Kinesis.GetRecordsHttp)`. For
push-based processing, prefer `consumeStreamRecords` (a Lambda event
source) over manual polling.
### Reading Records
**Example:** Read Records from a Shard
```typescript
// init — bind the operations to the stream
const getShardIterator = yield* AWS.Kinesis.GetShardIterator(stream);
const getRecords = yield* AWS.Kinesis.GetRecords(stream);

// runtime — obtain an iterator, then read
const iterator = yield* getShardIterator({
  ShardId: shardId,
  ShardIteratorType: "TRIM_HORIZON",
});
const result = yield* getRecords({
  ShardIterator: iterator.ShardIterator!,
});
for (const record of result.Records ?? []) {
  yield* Effect.log(record.PartitionKey);
}
```

@binding

## GetResourcePolicy

Runtime binding for `kinesis:GetResourcePolicy`.

Bind this operation to a `Stream` to read the resource policy attached to
it (set via the stream's `resourcePolicy` prop) — the stream ARN is
injected automatically. Provide the implementation with
`Effect.provide(AWS.Kinesis.GetResourcePolicyHttp)`.
### Inspecting Streams
**Example:** Read the Stream's Resource Policy
```typescript
// init
const getResourcePolicy = yield* AWS.Kinesis.GetResourcePolicy(stream);

// runtime
const result = yield* getResourcePolicy();
const policy = JSON.parse(result.Policy);
```

@binding

## GetShardIterator

Runtime binding for `kinesis:GetShardIterator`.

Bind this operation to a `Stream` to obtain a shard iterator — the starting
position for reading records with `AWS.Kinesis.GetRecords`. The stream name
is injected automatically. Provide the implementation with
`Effect.provide(AWS.Kinesis.GetShardIteratorHttp)`.
### Reading Records
**Example:** Obtain an Iterator for the Latest Position
```typescript
// init
const getShardIterator = yield* AWS.Kinesis.GetShardIterator(stream);

// runtime
const iterator = yield* getShardIterator({
  ShardId: shardId,
  ShardIteratorType: "LATEST",
});
// pass iterator.ShardIterator to getRecords
```

@binding

## ListShards

Runtime binding for `kinesis:ListShards`.

Bind this operation to a `Stream` to enumerate its shards — typically the
first step before obtaining a shard iterator and reading records. Provide
the implementation with `Effect.provide(AWS.Kinesis.ListShardsHttp)`.
### Inspecting Streams
**Example:** List the Stream's Shards
```typescript
// init
const listShards = yield* AWS.Kinesis.ListShards(stream);

// runtime
const result = yield* listShards();
const shardIds = (result.Shards ?? []).map((shard) => shard.ShardId);
```

@binding

## ListStreamConsumers

Runtime binding for `kinesis:ListStreamConsumers`.

Bind this operation to a `Stream` to enumerate the enhanced fan-out
consumers registered on it — the stream ARN is injected automatically.
Provide the implementation with
`Effect.provide(AWS.Kinesis.ListStreamConsumersHttp)`.
### Enhanced Fan-Out
**Example:** List Registered Consumers
```typescript
// init
const listStreamConsumers = yield* AWS.Kinesis.ListStreamConsumers(stream);

// runtime
const result = yield* listStreamConsumers();
const names = (result.Consumers ?? []).map((c) => c.ConsumerName);
```

@binding

## ListStreams

Runtime binding for `kinesis:ListStreams`.

An account-level operation (no stream argument) that enumerates all
Kinesis streams in the region. Provide the implementation with
`Effect.provide(AWS.Kinesis.ListStreamsHttp)`.
### Inspecting Streams
**Example:** List Streams in the Region
```typescript
// init — account-level binding takes no resource
const listStreams = yield* AWS.Kinesis.ListStreams();

// runtime
const result = yield* listStreams();
yield* Effect.log(result.StreamNames);
```

@binding

## MergeShards

Runtime binding for `kinesis:MergeShards`.

Bind this operation to a `Stream` to merge two adjacent shards of a
PROVISIONED-mode stream into one — the stream ARN is injected
automatically. Useful for building custom shard-scaling logic (the
`Stream` resource's `shardCount` prop covers uniform scaling via
`UpdateShardCount`; merge/split give per-shard control). Provide the
implementation with `Effect.provide(AWS.Kinesis.MergeShardsHttp)`.
### Managing Shards
**Example:** Merge Two Adjacent Shards
```typescript
// init — bind the operation to the stream
const mergeShards = yield* AWS.Kinesis.MergeShards(stream);

// runtime — merge a shard with its adjacent neighbor
yield* mergeShards({
  ShardToMerge: "shardId-000000000000",
  AdjacentShardToMerge: "shardId-000000000001",
});
```

@binding

## PutRecord

Runtime binding for `kinesis:PutRecord`.

Bind this operation to a `Stream` in the function's init phase to get a
callable that writes single records — the stream name is injected
automatically and `kinesis:PutRecord` is granted on the stream. Provide the
implementation with `Effect.provide(AWS.Kinesis.PutRecordHttp)`.
### Writing Records
**Example:** Put a Record from a Handler
```typescript
export default MyFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const stream = yield* AWS.Kinesis.Stream("OrdersStream");
    // init — bind the operation to the stream
    const putRecord = yield* AWS.Kinesis.PutRecord(stream);

    return {
      fetch: Effect.gen(function* () {
        // runtime — write a record
        yield* putRecord({
          PartitionKey: "order-123",
          Data: new TextEncoder().encode(JSON.stringify({ orderId: "123" })),
        });
        return HttpServerResponse.text("sent");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(AWS.Kinesis.PutRecordHttp)),
);
```

@binding

## PutRecords

Runtime binding for `kinesis:PutRecords`.

Bind this operation to a `Stream` to write up to 500 records per call —
the stream name is injected automatically and `kinesis:PutRecords` is
granted on the stream. Provide the implementation with
`Effect.provide(AWS.Kinesis.PutRecordsHttp)`. For unbounded batching with
automatic partial-failure retry, use `AWS.Kinesis.StreamSink` instead.
### Writing Batches
**Example:** Put a Batch of Records
```typescript
// init — bind the operation to the stream
const putRecords = yield* AWS.Kinesis.PutRecords(stream);

// runtime — write a batch from a handler
const result = yield* putRecords({
  Records: orders.map((order) => ({
    PartitionKey: order.id,
    Data: new TextEncoder().encode(JSON.stringify(order)),
  })),
});
// result.FailedRecordCount > 0 means some entries need re-submission
```

@binding

## SplitShard

Runtime binding for `kinesis:SplitShard`.

Bind this operation to a `Stream` to split one shard of a
PROVISIONED-mode stream into two — the stream ARN is injected
automatically. Useful for building custom shard-scaling logic that
targets a hot shard directly (the `Stream` resource's `shardCount`
prop covers uniform scaling via `UpdateShardCount`). Provide the
implementation with `Effect.provide(AWS.Kinesis.SplitShardHttp)`.
### Managing Shards
**Example:** Split a Hot Shard
```typescript
// init — bind the operation to the stream
const splitShard = yield* AWS.Kinesis.SplitShard(stream);

// runtime — split at the midpoint of the shard's hash-key range
yield* splitShard({
  ShardToSplit: "shardId-000000000000",
  NewStartingHashKey: "170141183460469231731687303715884105728",
});
```

@binding

## SubscribeToShard

Runtime binding for `kinesis:SubscribeToShard` (enhanced fan-out).

Bind this operation to a `StreamConsumer` (a registered enhanced fan-out
consumer) to open a push-based subscription to a shard — the consumer ARN
is injected automatically. Provide the implementation with
`Effect.provide(AWS.Kinesis.SubscribeToShardHttp)`.
### Enhanced Fan-Out
**Example:** Subscribe to a Shard
```typescript
const consumer = yield* AWS.Kinesis.StreamConsumer("Analytics", {
  streamArn: stream.streamArn,
});
// init — bind the operation to the registered consumer
const subscribeToShard = yield* AWS.Kinesis.SubscribeToShard(consumer);

// runtime — open the subscription
const result = yield* subscribeToShard({
  ShardId: shardId,
  StartingPosition: { Type: "LATEST" },
});
// result.EventStream delivers records for up to 5 minutes
```

@binding
