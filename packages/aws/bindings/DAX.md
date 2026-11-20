<!-- Docs for the generated AWS.DAX bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DecreaseReplicationFactor

Runtime binding for the `DecreaseReplicationFactor` operation (IAM action
`dax:DecreaseReplicationFactor`), scoped to one {@link Cluster}.

Removes read-replica nodes from the bound DAX cluster — the scale-in half
of node-count automation (e.g. shrinking a cluster off-peak to cut
node-hour cost). Provide the implementation with
`Effect.provide(AWS.DAX.DecreaseReplicationFactorHttp)`.
### Scaling a Cluster
**Example:** Scale In to One Node
```typescript
const decreaseReplicationFactor =
  yield* DAX.DecreaseReplicationFactor(cluster);

const result = yield* decreaseReplicationFactor({
  NewReplicationFactor: 1,
});
// result.Cluster?.TotalNodes → 1 once the removal completes
```

@binding

## DescribeClusters

Runtime binding for the `DescribeClusters` operation (IAM action
`dax:DescribeClusters`).

Lists the account's DAX clusters (optionally filtered by name) with node
status, endpoints and configuration embedded — the building block of
cluster-health monitoring and node-reboot automation. Provide the
implementation with `Effect.provide(AWS.DAX.DescribeClustersHttp)`.
### Monitoring Clusters
**Example:** Check a Cluster's Node Health
```typescript
const describeClusters = yield* DAX.DescribeClusters();

const page = yield* describeClusters({ ClusterNames: [clusterName] });
const available = page.Clusters?.[0]?.Nodes?.filter(
  (node) => node.NodeStatus === "available",
);
```

@binding

## DescribeEvents

Runtime binding for the `DescribeEvents` operation (IAM action
`dax:DescribeEvents`).

Returns events related to DAX clusters and parameter groups from the last
24 hours (up to 14 days with an explicit time window) — node reboots,
failovers, configuration changes. Provide the implementation with
`Effect.provide(AWS.DAX.DescribeEventsHttp)`.
### Monitoring Clusters
**Example:** Read a Cluster's Recent Events
```typescript
const describeEvents = yield* DAX.DescribeEvents();

const page = yield* describeEvents({
  SourceName: clusterName,
  SourceType: "CLUSTER",
});
for (const event of page.Events ?? []) {
  yield* Effect.logInfo(`${event.Date}: ${event.Message}`);
}
```

@binding

## IncreaseReplicationFactor

Runtime binding for the `IncreaseReplicationFactor` operation (IAM action
`dax:IncreaseReplicationFactor`), scoped to one {@link Cluster}.

Adds read-replica nodes to the bound DAX cluster — the building block of
scale-out automation (e.g. a Lambda reacting to a CloudWatch alarm on
cluster CPU or cache-miss rate). Provide the implementation with
`Effect.provide(AWS.DAX.IncreaseReplicationFactorHttp)`.
### Scaling a Cluster
**Example:** Scale Out to Three Nodes
```typescript
const increaseReplicationFactor =
  yield* DAX.IncreaseReplicationFactor(cluster);

const result = yield* increaseReplicationFactor({
  NewReplicationFactor: 3,
});
// result.Cluster?.TotalNodes → 3 (new nodes provision asynchronously)
```

@binding

## RebootNode

Runtime binding for the `RebootNode` operation (IAM action
`dax:RebootNode`), scoped to one {@link Cluster}.

Reboots a single node of the bound DAX cluster — restarts the DAX engine
process without flushing the cache contents. The node id comes from
`DescribeClusters` (e.g. `my-cluster-a`). Provide the implementation with
`Effect.provide(AWS.DAX.RebootNodeHttp)`.
### Operating a Cluster
**Example:** Reboot an Unhealthy Node
```typescript
const rebootNode = yield* DAX.RebootNode(cluster);

const result = yield* rebootNode({ NodeId: nodeId });
// result.Cluster?.Nodes → the node reports status "rebooting"
```

@binding
