<!-- Docs for the generated AWS.NeptuneGraph bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelExportTask

Runtime binding for the `CancelExportTask` operation (IAM action `neptune-graph:CancelExportTask`).

Cancels a running export task by id. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.CancelExportTaskHttp)`.
### Importing and Exporting Data
**Example:** Cancel an export
```typescript
const cancelExport = yield* NeptuneGraph.CancelExportTask();

yield* cancelExport({ taskIdentifier });
```

@binding

## CancelImportTask

Runtime binding for the `CancelImportTask` operation (IAM action `neptune-graph:CancelImportTask`).

Cancels a running import task by id. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.CancelImportTaskHttp)`.
### Importing and Exporting Data
**Example:** Cancel an import
```typescript
const cancelImport = yield* NeptuneGraph.CancelImportTask();

yield* cancelImport({ taskIdentifier });
```

@binding

## CancelQuery

Runtime binding for the `CancelQuery` operation (IAM action `neptune-graph:CancelQuery`),
scoped to one {@link Graph}.

Cancels a query running on the bound graph by its query id — e.g. kill a runaway openCypher traversal found via {@link ListQueries}. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.CancelQueryHttp)`.
### Managing Queries
**Example:** Cancel a runaway query
```typescript
const cancelQuery = yield* NeptuneGraph.CancelQuery(graph);

yield* cancelQuery({ queryId });
```

@binding

## CreateGraphSnapshot

Runtime binding for the `CreateGraphSnapshot` operation (IAM actions `neptune-graph:CreateGraphSnapshot` + `neptune-graph:TagResource`),
scoped to one {@link Graph}.

Takes an on-demand snapshot of the bound graph — e.g. a pre-import backup from an operational Lambda. Snapshot creation is asynchronous; poll it with {@link GetGraphSnapshot}. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.CreateGraphSnapshotHttp)`.
### Managing Snapshots
**Example:** Take an on-demand snapshot
```typescript
const createSnapshot = yield* NeptuneGraph.CreateGraphSnapshot(graph);

const snapshot = yield* createSnapshot({ snapshotName: "pre-import" });
// snapshot.status → "CREATING"
```

@binding

## DeleteGraphSnapshot

Runtime binding for the `DeleteGraphSnapshot` operation (IAM action `neptune-graph:DeleteGraphSnapshot`).

Deletes a graph snapshot by id — e.g. a retention Lambda pruning old backups found via {@link ListGraphSnapshots}. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.DeleteGraphSnapshotHttp)`.
### Managing Snapshots
**Example:** Prune an old snapshot
```typescript
const deleteSnapshot = yield* NeptuneGraph.DeleteGraphSnapshot();

yield* deleteSnapshot({ snapshotIdentifier });
```

@binding

## GetExportTask

Runtime binding for the `GetExportTask` operation (IAM action `neptune-graph:GetExportTask`).

Reads one export task by id — status, progress percentage, and exported-record counts. Task ids are server-generated runtime data. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.GetExportTaskHttp)`.
### Importing and Exporting Data
**Example:** Poll an export task
```typescript
const getExportTask = yield* NeptuneGraph.GetExportTask();

const task = yield* getExportTask({ taskIdentifier });
// task.status → "SUCCEEDED"
```

@binding

## GetGraphSnapshot

Runtime binding for the `GetGraphSnapshot` operation (IAM action `neptune-graph:GetGraphSnapshot`).

Reads one graph snapshot by id — status, source graph, and encryption key. Snapshot ids are server-generated runtime data, so the grant spans the account's snapshots. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.GetGraphSnapshotHttp)`.
### Managing Snapshots
**Example:** Poll a snapshot until available
```typescript
const getSnapshot = yield* NeptuneGraph.GetGraphSnapshot();

const snapshot = yield* getSnapshot({ snapshotIdentifier });
// snapshot.status → "AVAILABLE"
```

@binding

## GetGraphSummary

Runtime binding for the `GetGraphSummary` operation (IAM action `neptune-graph:GetGraphSummary`),
scoped to one {@link Graph}.

Reads the data summary of the bound graph — node/edge counts, labels, and (in `DETAILED` mode) per-label structure. Cheap way to sanity-check a load or drive dashboards without running a query. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.GetGraphSummaryHttp)`.
### Inspecting a Graph
**Example:** Read node and edge counts
```typescript
const getSummary = yield* NeptuneGraph.GetGraphSummary(graph);

const summary = yield* getSummary({ mode: "BASIC" });
// summary.graphSummary?.numNodes, summary.graphSummary?.numEdges
```

@binding

## GetImportTask

Runtime binding for the `GetImportTask` operation (IAM action `neptune-graph:GetImportTask`).

Reads one import task by id — status, progress statistics, and parsed-record counts. Task ids are server-generated runtime data. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.GetImportTaskHttp)`.
### Importing and Exporting Data
**Example:** Poll an import task
```typescript
const getImportTask = yield* NeptuneGraph.GetImportTask();

const task = yield* getImportTask({ taskIdentifier });
// task.status → "SUCCEEDED"
```

@binding

## GetQuery

Runtime binding for the `GetQuery` operation (IAM action `neptune-graph:GetQueryStatus`),
scoped to one {@link Graph}.

Retrieves the status of a query running on the bound graph (IAM action `neptune-graph:GetQueryStatus`). Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.GetQueryHttp)`.
### Managing Queries
**Example:** Check a running query
```typescript
const getQuery = yield* NeptuneGraph.GetQuery(graph);

const status = yield* getQuery({ queryId });
// status.state → "RUNNING" | "WAITING" | "CANCELLING"
```

@binding

## ListExportTasks

Runtime binding for the `ListExportTasks` operation (IAM action `neptune-graph:ListExportTasks`),
scoped to one {@link Graph}.

Lists the export tasks of the bound graph. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.ListExportTasksHttp)`.
### Importing and Exporting Data
**Example:** List a graph's export tasks
```typescript
const listExportTasks = yield* NeptuneGraph.ListExportTasks(graph);

const { tasks } = yield* listExportTasks();
```

@binding

## ListGraphSnapshots

Runtime binding for the `ListGraphSnapshots` operation (IAM action `neptune-graph:ListGraphSnapshots`),
scoped to one {@link Graph}.

Lists the snapshots of the bound graph. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.ListGraphSnapshotsHttp)`.
### Managing Snapshots
**Example:** List a graph's snapshots
```typescript
const listSnapshots = yield* NeptuneGraph.ListGraphSnapshots(graph);

const { graphSnapshots } = yield* listSnapshots();
```

@binding

## ListImportTasks

Runtime binding for the `ListImportTasks` operation (IAM action `neptune-graph:ListImportTasks`).

Lists the account's Neptune Analytics import tasks. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.ListImportTasksHttp)`.
### Importing and Exporting Data
**Example:** List import tasks
```typescript
const listImportTasks = yield* NeptuneGraph.ListImportTasks();

const { tasks } = yield* listImportTasks();
```

@binding

## ListQueries

Runtime binding for the `ListQueries` operation (IAM action `neptune-graph:ListQueries`),
scoped to one {@link Graph}.

Lists the openCypher queries currently active on the bound graph. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.ListQueriesHttp)`.
### Managing Queries
**Example:** List active queries
```typescript
const listQueries = yield* NeptuneGraph.ListQueries(graph);

const { queries } = yield* listQueries({ maxResults: 100 });
```

@binding

## ResetGraph

Runtime binding for the `ResetGraph` operation (IAM action `neptune-graph:ResetGraph`),
scoped to one {@link Graph}.

Empties all data from the bound graph while keeping the graph itself (and optionally snapshotting first) — e.g. refresh a demo or staging dataset before a re-import. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.ResetGraphHttp)`.
### Resetting a Graph
**Example:** Wipe all data from a graph
```typescript
const resetGraph = yield* NeptuneGraph.ResetGraph(graph);

yield* resetGraph({ skipSnapshot: true });
```

@binding

## StartExportTask

Runtime binding for the `StartExportTask` operation (IAM action `neptune-graph:StartExportTask`),
scoped to one {@link Graph}.

Exports the bound graph's data to Amazon S3 (the graph must be `AVAILABLE`). The request passes Neptune Analytics a data-access role, so the grant includes `iam:PassRole` conditioned to `neptune-graph.amazonaws.com`. Poll progress with {@link GetExportTask}. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.StartExportTaskHttp)`.
### Importing and Exporting Data
**Example:** Export a graph to S3 as Parquet
```typescript
const startExport = yield* NeptuneGraph.StartExportTask(graph);

const task = yield* startExport({
  destination: "s3://my-bucket/exports/",
  format: "PARQUET",
  kmsKeyIdentifier: key.keyArn,
  roleArn: exportRole.roleArn,
});
```

@binding

## StartGraph

Runtime binding for the `StartGraph` operation (IAM action `neptune-graph:StartGraph`),
scoped to one {@link Graph}.

Restarts the bound graph after it was stopped — m-NCU billing resumes and the graph transitions back to `AVAILABLE`. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.StartGraphHttp)`.
### Starting and Stopping a Graph
**Example:** Start a stopped graph
```typescript
const startGraph = yield* NeptuneGraph.StartGraph(graph);

const result = yield* startGraph();
// result.status → transitioning toward AVAILABLE
```

@binding

## StartImportTask

Runtime binding for the `StartImportTask` operation (IAM action `neptune-graph:StartImportTask`),
scoped to one {@link Graph}.

Starts a bulk import from Amazon S3 into the bound graph (the graph must be empty and `AVAILABLE`). The request passes Neptune Analytics a data-access role, so the grant includes `iam:PassRole` conditioned to `neptune-graph.amazonaws.com`. Poll progress with {@link GetImportTask}. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.StartImportTaskHttp)`.
### Importing and Exporting Data
**Example:** Bulk-load CSV data from S3
```typescript
const startImport = yield* NeptuneGraph.StartImportTask(graph);

const task = yield* startImport({
  source: "s3://my-bucket/graph-data/",
  format: "CSV",
  roleArn: importRole.roleArn,
});
// task.taskId, task.status
```

@binding

## StopGraph

Runtime binding for the `StopGraph` operation (IAM action `neptune-graph:StopGraph`),
scoped to one {@link Graph}.

Stops the bound graph to pause compute (m-NCU) billing while retaining data — e.g. a scheduler Lambda parking dev graphs overnight. Restart with {@link StartGraph}. Provide the implementation with
`Effect.provide(AWS.NeptuneGraph.StopGraphHttp)`.
### Starting and Stopping a Graph
**Example:** Stop a graph to pause billing
```typescript
const stopGraph = yield* NeptuneGraph.StopGraph(graph);

const result = yield* stopGraph();
// result.status → "STOPPING"
```

@binding
