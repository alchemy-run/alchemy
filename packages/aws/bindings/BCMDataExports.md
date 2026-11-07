<!-- Docs for the generated AWS.BCMDataExports bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetExecution

Runtime binding for `bcm-data-exports:GetExecution`.

Bind this operation to an {@link Export} to read the status of one export
execution (delivery run) — its status code, reason, and timestamps — from
inside a function runtime. Useful for delivery monitors that alert when a
refresh fails. Provide the implementation with
`Effect.provide(AWS.BCMDataExports.GetExecutionHttp)`.
### Monitoring Executions
**Example:** Check an Execution's Status
```typescript
// init — bind the operation to the export
const getExecution = yield* AWS.BCMDataExports.GetExecution(cur);

// runtime
const result = yield* getExecution({ ExecutionId: executionId });
const status = result.ExecutionStatus?.StatusCode;
```

@binding

## GetExecution.Request

Request for {@link GetExecution} — the bound export's ARN is injected
automatically.

## GetExport

Runtime binding for `bcm-data-exports:GetExport`.

Bind this operation to an {@link Export} to read the export's live
definition — SQL query, table configurations, S3 destination, and refresh
cadence — from inside a function runtime. Useful for cost dashboards that
surface where their billing data lands. Provide the implementation with
`Effect.provide(AWS.BCMDataExports.GetExportHttp)`.
### Inspecting an Export
**Example:** Read the Export's Definition
```typescript
// init — bind the operation to the export
const getExport = yield* AWS.BCMDataExports.GetExport(cur);

// runtime
const { Export: definition } = yield* getExport();
const bucket = definition?.DestinationConfigurations.S3Destination.S3Bucket;
```

@binding

## GetTable

Runtime binding for `bcm-data-exports:GetTable`.

An account-level operation (the table dictionary is not tied to any
export) that reads the schema of a Data Exports table — its columns,
data types, and descriptions for the given table properties. Useful for
query builders that validate an SQL statement's columns before calling
`UpdateExport`. Provide the implementation with
`Effect.provide(AWS.BCMDataExports.GetTableHttp)`.
### Browsing the Table Dictionary
**Example:** Read a Table's Schema
```typescript
// init — account-level binding takes no resource
const getTable = yield* AWS.BCMDataExports.GetTable();

// runtime
const table = yield* getTable({ TableName: "COST_AND_USAGE_REPORT" });
const columns = (table.Schema ?? []).map((column) => column.Name);
```

@binding

## GetTable.Request

Request for {@link GetTable}.

## ListExecutions

Runtime binding for `bcm-data-exports:ListExecutions`.

Bind this operation to an {@link Export} to page through the export's
historical executions (delivery runs) from inside a function runtime.
Useful for delivery dashboards and monitors that scan for failed
refreshes. Provide the implementation with
`Effect.provide(AWS.BCMDataExports.ListExecutionsHttp)`.
### Monitoring Executions
**Example:** List Recent Executions
```typescript
// init — bind the operation to the export
const listExecutions = yield* AWS.BCMDataExports.ListExecutions(cur);

// runtime
const result = yield* listExecutions({ MaxResults: 25 });
const failed = (result.Executions ?? []).filter(
  (execution) =>
    execution.ExecutionStatus.StatusCode === "DELIVERY_FAILURE",
);
```

@binding

## ListExecutions.Request

Request for {@link ListExecutions} — the bound export's ARN is injected
automatically.

## ListExports

Runtime binding for `bcm-data-exports:ListExports`.

An account-level operation (no export argument) that enumerates every data
export definition in the account. Useful for governance sweeps that audit
where billing data is being delivered. Provide the implementation with
`Effect.provide(AWS.BCMDataExports.ListExportsHttp)`.
### Inspecting an Export
**Example:** List Every Export in the Account
```typescript
// init — account-level binding takes no resource
const listExports = yield* AWS.BCMDataExports.ListExports();

// runtime
const result = yield* listExports({ MaxResults: 100 });
const names = (result.Exports ?? []).map((e) => e.ExportName);
```

@binding

## ListExports.Request

Request for {@link ListExports}.

## ListTables

Runtime binding for `bcm-data-exports:ListTables`.

An account-level operation (the table dictionary is not tied to any
export) that enumerates every table available to Data Exports queries,
with each table's configurable properties. Useful for query builders that
present the available data sources. Provide the implementation with
`Effect.provide(AWS.BCMDataExports.ListTablesHttp)`.
### Browsing the Table Dictionary
**Example:** List the Available Tables
```typescript
// init — account-level binding takes no resource
const listTables = yield* AWS.BCMDataExports.ListTables();

// runtime
const result = yield* listTables();
const names = (result.Tables ?? []).map((table) => table.TableName);
```

@binding

## ListTables.Request

Request for {@link ListTables}.
