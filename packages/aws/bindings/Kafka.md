<!-- Docs for the generated AWS.Kafka bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateTopic

Runtime binding for the `CreateTopic` operation (IAM action
`kafka:CreateTopic`), scoped to one {@link ServerlessCluster}.

Creates a Kafka topic on the bound cluster through the MSK control plane —
no Kafka admin client or VPC connectivity required. Provide the
implementation with `Effect.provide(AWS.Kafka.CreateTopicHttp)`.
### Managing Topics
**Example:** Create a Topic
```typescript
const createTopic = yield* Kafka.CreateTopic(cluster);

const topic = yield* createTopic({
  TopicName: "orders",
  PartitionCount: 3,
});
// topic.TopicArn, topic.Status → "CREATING" | "ACTIVE"
```

@binding

## DeleteTopic

Runtime binding for the `DeleteTopic` operation (IAM action
`kafka:DeleteTopic`), scoped to one {@link ServerlessCluster}.

Deletes a Kafka topic on the bound cluster through the MSK control plane.
Provide the implementation with `Effect.provide(AWS.Kafka.DeleteTopicHttp)`.
### Managing Topics
**Example:** Delete a Topic
```typescript
const deleteTopic = yield* Kafka.DeleteTopic(cluster);

yield* deleteTopic({ TopicName: "orders" });
```

@binding

## DescribeTopic

Runtime binding for the `DescribeTopic` operation (IAM action
`kafka:DescribeTopic`), scoped to one {@link ServerlessCluster}.

Reads a topic's partition count, replication factor, configuration, and
status through the MSK control plane. Provide the implementation with
`Effect.provide(AWS.Kafka.DescribeTopicHttp)`.
### Managing Topics
**Example:** Describe a Topic
```typescript
const describeTopic = yield* Kafka.DescribeTopic(cluster);

const topic = yield* describeTopic({ TopicName: "orders" });
// topic.PartitionCount, topic.Configs, topic.Status
```

@binding

## DescribeTopicPartitions

Runtime binding for the `DescribeTopicPartitions` operation (IAM action
`kafka:DescribeTopicPartitions`), scoped to one {@link ServerlessCluster}.

Reads per-partition detail (leader, replicas, ISR) for a topic through the
MSK control plane. Pass `NextToken` from the previous page to paginate.
Provide the implementation with
`Effect.provide(AWS.Kafka.DescribeTopicPartitionsHttp)`.
### Managing Topics
**Example:** Read a Topic's Partitions
```typescript
const describeTopicPartitions = yield* Kafka.DescribeTopicPartitions(cluster);

const page = yield* describeTopicPartitions({ TopicName: "orders" });
// page.Partitions → [{ Partition: 0, Leader: …, Isr: […] }, …]
```

@binding

## GetBootstrapBrokers

Runtime binding for the `GetBootstrapBrokers` operation (IAM action
`kafka:GetBootstrapBrokers`), scoped to one {@link ServerlessCluster}.

Resolves the cluster's bootstrap broker connection strings at runtime —
for MSK Serverless the SASL/IAM string
(`BootstrapBrokerStringSaslIam`) is the one Kafka clients connect to.
Provide the implementation with
`Effect.provide(AWS.Kafka.GetBootstrapBrokersHttp)`.
### Connecting to a Cluster
**Example:** Resolve the SASL/IAM Bootstrap Brokers
```typescript
const getBootstrapBrokers = yield* Kafka.GetBootstrapBrokers(cluster);

const brokers = yield* getBootstrapBrokers();
// brokers.BootstrapBrokerStringSaslIam → "b-1.….kafka-serverless.…:9098"
```

@binding

## ListTopics

Runtime binding for the `ListTopics` operation (IAM action
`kafka:ListTopics`), scoped to one {@link ServerlessCluster}.

Lists the topics on the bound cluster through the MSK control plane,
optionally filtered by name prefix. Provide the implementation with
`Effect.provide(AWS.Kafka.ListTopicsHttp)`.
### Managing Topics
**Example:** List the Cluster's Topics
```typescript
const listTopics = yield* Kafka.ListTopics(cluster);

const page = yield* listTopics({ TopicNameFilter: "orders" });
// page.Topics → [{ TopicName: "orders", PartitionCount: 3, … }]
```

@binding

## UpdateTopic

Runtime binding for the `UpdateTopic` operation (IAM action
`kafka:UpdateTopic`), scoped to one {@link ServerlessCluster}.

Updates a topic's configuration or increases its partition count through
the MSK control plane. Provide the implementation with
`Effect.provide(AWS.Kafka.UpdateTopicHttp)`.
### Managing Topics
**Example:** Grow a Topic's Partitions
```typescript
const updateTopic = yield* Kafka.UpdateTopic(cluster);

yield* updateTopic({ TopicName: "orders", PartitionCount: 6 });
```

@binding
