<!-- Docs for the generated AWS.Athena bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchGetQueryExecution

Runtime binding for `athena:BatchGetQueryExecution`.

Reads up to 50 query executions from the bound workgroup in one call.
Provide the implementation with
`Effect.provide(AWS.Athena.BatchGetQueryExecutionHttp)`.
### Inspecting Query Executions
**Example:** Read Several Executions at Once
```typescript
// init — bind the operation to the workgroup
const batchGetQueryExecution =
  yield* AWS.Athena.BatchGetQueryExecution(workGroup);

// runtime
const res = yield* batchGetQueryExecution({ QueryExecutionIds: ids });
console.log(res.QueryExecutions?.map((qe) => qe.Status?.State));
```

@binding

## GetDatabase

Runtime binding for `athena:GetDatabase`.

Reads a single database's metadata from the bound data catalog — the
catalog name is injected automatically. Provide the implementation with
`Effect.provide(AWS.Athena.GetDatabaseHttp)`.
### Browsing Catalog Metadata
**Example:** Read a Database from the Catalog
```typescript
// init — bind the operation to the data catalog
const getDatabase = yield* AWS.Athena.GetDatabase(catalog);

// runtime
const res = yield* getDatabase({ DatabaseName: "analytics" });
console.log(res.Database?.Name);
```

@binding

## GetQueryExecution

Runtime binding for `athena:GetQueryExecution`.

Reads the state, statistics, and configuration of a single query execution
that ran in the bound workgroup. Provide the implementation with
`Effect.provide(AWS.Athena.GetQueryExecutionHttp)`.
### Inspecting Query Executions
**Example:** Check a Query's State
```typescript
// init — bind the operation to the workgroup
const getQueryExecution = yield* AWS.Athena.GetQueryExecution(workGroup);

// runtime
const res = yield* getQueryExecution({ QueryExecutionId: id });
console.log(res.QueryExecution?.Status?.State);
```

@binding

## GetQueryResults

Runtime binding for `athena:GetQueryResults`.

Reads one page of a completed query's result set (raw rows + column
metadata) — use `NextToken`/`MaxResults` to paginate large results. For the
common run-and-decode flow, prefer the composite {@link Query} binding.
Provide the implementation with
`Effect.provide(AWS.Athena.GetQueryResultsHttp)`.
### Reading Results
**Example:** Page Through Query Results
```typescript
// init — bind the operation to the workgroup
const getQueryResults = yield* AWS.Athena.GetQueryResults(workGroup);

// runtime
const page = yield* getQueryResults({ QueryExecutionId: id, MaxResults: 100 });
console.log(page.ResultSet?.Rows?.length, page.NextToken);
```

@binding

## GetQueryRuntimeStatistics

Runtime binding for `athena:GetQueryRuntimeStatistics`.

Reads the runtime statistics (timeline, rows/bytes processed, stage tree)
of a query that ran in the bound workgroup. Provide the implementation with
`Effect.provide(AWS.Athena.GetQueryRuntimeStatisticsHttp)`.
### Inspecting Query Executions
**Example:** Read a Query's Runtime Statistics
```typescript
// init — bind the operation to the workgroup
const getQueryRuntimeStatistics =
  yield* AWS.Athena.GetQueryRuntimeStatistics(workGroup);

// runtime
const res = yield* getQueryRuntimeStatistics({ QueryExecutionId: id });
console.log(res.QueryRuntimeStatistics?.Timeline?.TotalExecutionTimeInMillis);
```

@binding

## GetTableMetadata

Runtime binding for `athena:GetTableMetadata`.

Reads a single table's metadata (columns, partition keys, table type) from
the bound data catalog — the catalog name is injected automatically.
Provide the implementation with
`Effect.provide(AWS.Athena.GetTableMetadataHttp)`.
### Browsing Catalog Metadata
**Example:** Read a Table's Columns
```typescript
// init — bind the operation to the data catalog
const getTableMetadata = yield* AWS.Athena.GetTableMetadata(catalog);

// runtime
const res = yield* getTableMetadata({
  DatabaseName: "analytics",
  TableName: "orders",
});
console.log(res.TableMetadata?.Columns?.map((c) => c.Name));
```

@binding

## ListDatabases

Runtime binding for `athena:ListDatabases`.

Lists the databases in the bound data catalog — the catalog name is
injected automatically. Provide the implementation with
`Effect.provide(AWS.Athena.ListDatabasesHttp)`.
### Browsing Catalog Metadata
**Example:** List Databases in the Catalog
```typescript
// init — bind the operation to the data catalog
const listDatabases = yield* AWS.Athena.ListDatabases(catalog);

// runtime
const res = yield* listDatabases({});
console.log(res.DatabaseList?.map((db) => db.Name));
```

@binding

## ListNamedQueries

Runtime binding for `athena:ListNamedQueries`.

Lists the IDs of the saved (named) queries in the bound workgroup — the
workgroup name is injected automatically. Provide the implementation with
`Effect.provide(AWS.Athena.ListNamedQueriesHttp)`.
### Saved Queries
**Example:** List the Workgroup's Named Queries
```typescript
// init — bind the operation to the workgroup
const listNamedQueries = yield* AWS.Athena.ListNamedQueries(workGroup);

// runtime
const res = yield* listNamedQueries({ MaxResults: 50 });
console.log(res.NamedQueryIds);
```

@binding

## ListPreparedStatements

Runtime binding for `athena:ListPreparedStatements`.

Lists the prepared statements (name + last-modified time) in the bound
workgroup — the workgroup name is injected automatically. Provide the
implementation with `Effect.provide(AWS.Athena.ListPreparedStatementsHttp)`.
### Prepared Statements
**Example:** List the Workgroup's Prepared Statements
```typescript
// init — bind the operation to the workgroup
const listPreparedStatements =
  yield* AWS.Athena.ListPreparedStatements(workGroup);

// runtime
const res = yield* listPreparedStatements({ MaxResults: 50 });
console.log(res.PreparedStatements?.map((s) => s.StatementName));
```

@binding

## ListQueryExecutions

Runtime binding for `athena:ListQueryExecutions`.

Lists recent query execution IDs in the bound workgroup (newest first) —
the workgroup name is injected automatically. Provide the implementation
with `Effect.provide(AWS.Athena.ListQueryExecutionsHttp)`.
### Inspecting Query Executions
**Example:** List Recent Executions in the Workgroup
```typescript
// init — bind the operation to the workgroup
const listQueryExecutions = yield* AWS.Athena.ListQueryExecutions(workGroup);

// runtime
const res = yield* listQueryExecutions({ MaxResults: 10 });
console.log(res.QueryExecutionIds);
```

@binding

## ListTableMetadata

Runtime binding for `athena:ListTableMetadata`.

Lists table metadata for a database in the bound data catalog — the
catalog name is injected automatically; `Expression` filters table names.
Provide the implementation with
`Effect.provide(AWS.Athena.ListTableMetadataHttp)`.
### Browsing Catalog Metadata
**Example:** List a Database's Tables
```typescript
// init — bind the operation to the data catalog
const listTableMetadata = yield* AWS.Athena.ListTableMetadata(catalog);

// runtime
const res = yield* listTableMetadata({ DatabaseName: "analytics" });
console.log(res.TableMetadataList?.map((t) => t.Name));
```

@binding

## StopQueryExecution

Runtime binding for `athena:StopQueryExecution`.

Cancels a running query in the bound workgroup. Stopping an already
finished query is a no-op, so the call is safely idempotent. Provide the
implementation with `Effect.provide(AWS.Athena.StopQueryExecutionHttp)`.
### Cancelling Queries
**Example:** Cancel a Runaway Query
```typescript
// init — bind the operation to the workgroup
const stopQueryExecution = yield* AWS.Athena.StopQueryExecution(workGroup);

// runtime
yield* stopQueryExecution({ QueryExecutionId: id });
```

@binding
