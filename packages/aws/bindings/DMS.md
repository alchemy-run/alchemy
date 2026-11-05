<!-- Docs for the generated AWS.DMS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeConnections

Runtime binding for `dms:DescribeConnections`.

Bind this operation (account-level) to poll the results of connection
tests started with {@link TestConnection} — filter by `endpoint-arn` or
`replication-instance-arn`. Provide the implementation with
`Effect.provide(AWS.DMS.DescribeConnectionsHttp)`.
### Polling Connection Tests
**Example:** Poll a Test Result for an Endpoint
```typescript
// init — account-level, no target resource
const describeConnections = yield* AWS.DMS.DescribeConnections();

// runtime
const { Connections } = yield* describeConnections({
  Filters: [{ Name: "endpoint-arn", Values: [endpointArn] }],
});
// Connections[0].Status: "testing" | "successful" | "failed"
```

@binding

## DescribeEndpointSettings

Runtime binding for `dms:DescribeEndpointSettings`.

Bind this operation (account-level) to enumerate the settings an endpoint
engine supports — names, types, enum values, defaults — e.g. to validate
user-supplied endpoint configuration before creating endpoints. Provide
the implementation with
`Effect.provide(AWS.DMS.DescribeEndpointSettingsHttp)`.
### Inspecting Engine Settings
**Example:** List the Settings MySQL Endpoints Accept
```typescript
// init — account-level, no target resource
const endpointSettings = yield* AWS.DMS.DescribeEndpointSettings();

// runtime
const { EndpointSettings } = yield* endpointSettings({
  EngineName: "mysql",
});
```

@binding

## DescribeEvents

Runtime binding for `dms:DescribeEvents`.

Bind this operation (account-level) to read recent DMS events — instance
reboots, failovers, configuration changes — for monitoring and audit
workloads. Provide the implementation with
`Effect.provide(AWS.DMS.DescribeEventsHttp)`.
### Reading DMS Events
**Example:** Read the Last Hour of Instance Events
```typescript
// init — account-level, no target resource
const describeEvents = yield* AWS.DMS.DescribeEvents();

// runtime
const { Events } = yield* describeEvents({
  SourceType: "replication-instance",
  Duration: 60, // minutes
});
```

@binding

## DescribeOrderableReplicationInstances

Runtime binding for `dms:DescribeOrderableReplicationInstances`.

Bind this operation (account-level) to enumerate the replication instance
classes and storage ranges orderable in the region — e.g. for tooling that
right-sizes migration infrastructure. Provide the implementation with
`Effect.provide(AWS.DMS.DescribeOrderableReplicationInstancesHttp)`.
### Sizing Replication Instances
**Example:** List Orderable Instance Classes
```typescript
// init — account-level, no target resource
const orderable = yield* AWS.DMS.DescribeOrderableReplicationInstances();

// runtime
const { OrderableReplicationInstances } = yield* orderable();
```

@binding

## DescribeRefreshSchemasStatus

Runtime binding for `dms:DescribeRefreshSchemasStatus`.

Bind this operation to an {@link Endpoint} to poll the status of the last
`RefreshSchemas` run against it (`refreshing`, `successful`, `failed`).
Provide the implementation with
`Effect.provide(AWS.DMS.DescribeRefreshSchemasStatusHttp)`.
### Polling a Schema Refresh
**Example:** Wait for a Refresh to Complete
```typescript
// init — bind the operation to the endpoint
const refreshStatus = yield* AWS.DMS.DescribeRefreshSchemasStatus(source);

// runtime
const { RefreshSchemasStatus } = yield* refreshStatus();
if (RefreshSchemasStatus?.Status === "successful") {
  // schemas are ready to describe
}
```

@binding

## DescribeReplicationInstanceTaskLogs

Runtime binding for `dms:DescribeReplicationInstanceTaskLogs`.

Bind this operation to a {@link ReplicationInstance} to inspect the size of
the task logs accumulated on the instance — useful for storage-pressure
monitoring and deciding when to purge logs. Provide the implementation with
`Effect.provide(AWS.DMS.DescribeReplicationInstanceTaskLogsHttp)`.
### Inspecting Task Logs
**Example:** Report Task Log Sizes
```typescript
// init — bind the operation to the instance
const taskLogs = yield* AWS.DMS.DescribeReplicationInstanceTaskLogs(instance);

// runtime
const { ReplicationInstanceTaskLogs } = yield* taskLogs();
```

@binding

## DescribeReplicationTasks

Runtime binding for `dms:DescribeReplicationTasks`.

Bind this operation (account-level) to look up replication tasks and
their status/progress — filter by `replication-task-id`,
`replication-task-arn`, `endpoint-arn`, or `replication-instance-arn`.
The building block of migration monitoring and start/stop automation
(pair with {@link StartReplicationTask} / {@link StopReplicationTask}).
Provide the implementation with
`Effect.provide(AWS.DMS.DescribeReplicationTasksHttp)`.
### Orchestrating Replication Tasks
**Example:** Check a Task's Status Before Starting It
```typescript
// init — account-level, no target resource
const describeReplicationTasks = yield* AWS.DMS.DescribeReplicationTasks();

// runtime
const { ReplicationTasks } = yield* describeReplicationTasks({
  Filters: [{ Name: "replication-task-arn", Values: [taskArn] }],
});
// ReplicationTasks[0].Status: "ready" | "running" | "stopped" | …
```

@binding

## DescribeReplications

Runtime binding for `dms:DescribeReplications`.

Bind this operation (account-level) to look up DMS Serverless
replications and their provisioning/replication status — filter by
`replication-config-arn` or `replication-config-id`. Pair with
{@link StartReplication} / {@link StopReplication} for serverless
replication automation. Provide the implementation with
`Effect.provide(AWS.DMS.DescribeReplicationsHttp)`.
### Orchestrating Serverless Replications
**Example:** Check a Serverless Replication's Status
```typescript
// init — account-level, no target resource
const describeReplications = yield* AWS.DMS.DescribeReplications();

// runtime
const { Replications } = yield* describeReplications({
  Filters: [{ Name: "replication-config-arn", Values: [configArn] }],
});
// Replications[0].Status: "created" | "running" | "stopped" | …
```

@binding

## DescribeSchemas

Runtime binding for `dms:DescribeSchemas`.

Bind this operation to an {@link Endpoint} to list the schemas DMS
discovered at the endpoint's database (populated by a prior
`RefreshSchemas` run against a replication instance). Provide the
implementation with `Effect.provide(AWS.DMS.DescribeSchemasHttp)`.
### Listing Discovered Schemas
**Example:** List Schemas at a Source Endpoint
```typescript
// init — bind the operation to the endpoint
const describeSchemas = yield* AWS.DMS.DescribeSchemas(source);

// runtime
const { Schemas } = yield* describeSchemas();
```

@binding

## DescribeTableStatistics

Runtime binding for `dms:DescribeTableStatistics`.

Bind this operation (account-level) to read per-table migration progress
for a replication task — rows inserted/updated/deleted, full-load
completion, validation state. The data behind migration progress
dashboards and cut-over gates. Provide the implementation with
`Effect.provide(AWS.DMS.DescribeTableStatisticsHttp)`.
### Monitoring Migration Progress
**Example:** Gate a Cut-Over on Full-Load Completion
```typescript
// init — account-level, no target resource
const describeTableStatistics = yield* AWS.DMS.DescribeTableStatistics();

// runtime
const { TableStatistics } = yield* describeTableStatistics({
  ReplicationTaskArn: taskArn,
});
const pending = TableStatistics?.filter(
  (table) => table.FullLoadEndTime === undefined,
);
```

@binding

## RebootReplicationInstance

Runtime binding for `dms:RebootReplicationInstance`.

Bind this operation to a {@link ReplicationInstance} to reboot it (e.g. to
recover a stuck migration or force a Multi-AZ failover with
`ForceFailover`). Provide the implementation with
`Effect.provide(AWS.DMS.RebootReplicationInstanceHttp)`.
### Rebooting an Instance
**Example:** Reboot with Planned Failover
```typescript
// init — bind the operation to the instance
const reboot = yield* AWS.DMS.RebootReplicationInstance(instance);

// runtime
yield* reboot({ ForcePlannedFailover: true });
```

@binding

## ReloadTables

Runtime binding for `dms:ReloadTables`.

Bind this operation (account-level) to re-run the full load for specific
tables of a running replication task — the standard remediation when
{@link DescribeTableStatistics} reports table errors or validation
failures. Provide the implementation with
`Effect.provide(AWS.DMS.ReloadTablesHttp)`.
### Monitoring Migration Progress
**Example:** Reload a Failed Table
```typescript
// init — account-level, no target resource
const reloadTables = yield* AWS.DMS.ReloadTables();

// runtime
yield* reloadTables({
  ReplicationTaskArn: taskArn,
  TablesToReload: [{ SchemaName: "public", TableName: "orders" }],
});
```

@binding

## StartReplication

Runtime binding for `dms:StartReplication`.

Bind this operation (account-level) to start a DMS Serverless replication
for a replication config by ARN — DMS provisions the required capacity
and begins replicating. The serverless counterpart of
{@link StartReplicationTask}. Provide the implementation with
`Effect.provide(AWS.DMS.StartReplicationHttp)`.
### Orchestrating Serverless Replications
**Example:** Start a Serverless Replication
```typescript
// init — account-level, no target resource
const startReplication = yield* AWS.DMS.StartReplication();

// runtime
const { Replication } = yield* startReplication({
  ReplicationConfigArn: configArn,
  StartReplicationType: "start-replication",
});
```

@binding

## StartReplicationTask

Runtime binding for `dms:StartReplicationTask`.

Bind this operation (account-level) to start, resume, or reload a
replication task by ARN — the canonical DMS automation (a scheduled
Function that starts CDC during business hours, an event-driven Function
that kicks off a migration when upstream data lands). Provide the
implementation with `Effect.provide(AWS.DMS.StartReplicationTaskHttp)`.
### Orchestrating Replication Tasks
**Example:** Start a Task
```typescript
// init — account-level, no target resource
const startReplicationTask = yield* AWS.DMS.StartReplicationTask();

// runtime
const { ReplicationTask } = yield* startReplicationTask({
  ReplicationTaskArn: taskArn,
  StartReplicationTaskType: "start-replication",
});
```

@binding

## StopReplication

Runtime binding for `dms:StopReplication`.

Bind this operation (account-level) to stop a running DMS Serverless
replication by replication-config ARN (the stopped replication keeps its
provisioned capacity). The serverless counterpart of
{@link StopReplicationTask}. Provide the implementation with
`Effect.provide(AWS.DMS.StopReplicationHttp)`.
### Orchestrating Serverless Replications
**Example:** Stop a Serverless Replication
```typescript
// init — account-level, no target resource
const stopReplication = yield* AWS.DMS.StopReplication();

// runtime
const { Replication } = yield* stopReplication({
  ReplicationConfigArn: configArn,
});
```

@binding

## StopReplicationTask

Runtime binding for `dms:StopReplicationTask`.

Bind this operation (account-level) to stop a running replication task by
ARN — the other half of scheduled CDC windows and cost-control automation
(pair with {@link StartReplicationTask}). Provide the implementation with
`Effect.provide(AWS.DMS.StopReplicationTaskHttp)`.
### Orchestrating Replication Tasks
**Example:** Stop a Running Task
```typescript
// init — account-level, no target resource
const stopReplicationTask = yield* AWS.DMS.StopReplicationTask();

// runtime
const { ReplicationTask } = yield* stopReplicationTask({
  ReplicationTaskArn: taskArn,
});
```

@binding
