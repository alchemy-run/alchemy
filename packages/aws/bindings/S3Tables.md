<!-- Docs for the generated AWS.S3Tables bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetTable

Runtime binding for the `GetTable` operation (IAM action
`s3tables:GetTable` on the table ARN).

Reads the bound {@link Table}'s details — its current `versionToken`,
`metadataLocation`, `warehouseLocation`, and format. The version token and
metadata location are the inputs to the Iceberg commit protocol (see
{@link UpdateTableMetadataLocation}). Provide the implementation with
`Effect.provide(AWS.S3Tables.GetTableHttp)`.
### Reading Table Metadata
**Example:** Read the table's current version
```typescript
const getTable = yield* AWS.S3Tables.GetTable(table);

const { versionToken, metadataLocation, warehouseLocation } =
  yield* getTable();
```

@binding

## GetTableMaintenanceJobStatus

Runtime binding for the `GetTableMaintenanceJobStatus` operation (IAM
action `s3tables:GetTableMaintenanceJobStatus` on the table ARN).

Reads the status of the bound {@link Table}'s managed maintenance jobs —
Iceberg compaction and snapshot management — including when each job last
ran and whether it succeeded. Useful for compute that monitors table
health at runtime. Provide the implementation with
`Effect.provide(AWS.S3Tables.GetTableMaintenanceJobStatusHttp)`.
### Monitoring Maintenance
**Example:** Inspect maintenance job statuses
```typescript
const getTableMaintenanceJobStatus =
  yield* AWS.S3Tables.GetTableMaintenanceJobStatus(table);

const { status } = yield* getTableMaintenanceJobStatus();
for (const [job, state] of Object.entries(status)) {
  yield* Effect.log(`${job}: ${state?.status}`);
}
```

@binding

## GetTableMetadataLocation

Runtime binding for the `GetTableMetadataLocation` operation (IAM action
`s3tables:GetTableMetadataLocation` on the table ARN).

Reads the bound {@link Table}'s current metadata location and version
token — the read half of the Iceberg commit protocol: read the current
metadata, write a new metadata file to the warehouse, then commit it with
{@link UpdateTableMetadataLocation}. Provide the implementation with
`Effect.provide(AWS.S3Tables.GetTableMetadataLocationHttp)`.
### The Iceberg Commit Protocol
**Example:** Read the current metadata location
```typescript
const getTableMetadataLocation =
  yield* AWS.S3Tables.GetTableMetadataLocation(table);

const { versionToken, metadataLocation, warehouseLocation } =
  yield* getTableMetadataLocation();
```

@binding

## ListNamespaces

Runtime binding for the `ListNamespaces` operation (IAM action
`s3tables:ListNamespaces` on the table bucket ARN).

Lists the namespaces in the bound {@link TableBucket} — the catalog's
databases. Useful for compute that discovers tables dynamically at
runtime. Provide the implementation with
`Effect.provide(AWS.S3Tables.ListNamespacesHttp)`.
### Discovering Namespaces and Tables
**Example:** List the bucket's namespaces
```typescript
const listNamespaces = yield* AWS.S3Tables.ListNamespaces(bucket);

const { namespaces } = yield* listNamespaces();
for (const ns of namespaces) {
  yield* Effect.log(`namespace: ${ns.namespace[0]}`);
}
```

@binding

## ListNamespaces.Request

`ListNamespaces` request with `tableBucketARN` injected from the bound
{@link TableBucket}.

## ListTables

Runtime binding for the `ListTables` operation (IAM action
`s3tables:ListTables` on the table bucket ARN).

Lists the tables in the bound {@link TableBucket}, optionally filtered to
a namespace or name prefix. Useful for compute that enumerates the
catalog at runtime. Provide the implementation with
`Effect.provide(AWS.S3Tables.ListTablesHttp)`.
### Discovering Namespaces and Tables
**Example:** List the tables in a namespace
```typescript
const listTables = yield* AWS.S3Tables.ListTables(bucket);

const { tables } = yield* listTables({ namespace: "events" });
for (const table of tables) {
  yield* Effect.log(`table: ${table.name}`);
}
```

@binding

## ListTables.Request

`ListTables` request with `tableBucketARN` injected from the bound
{@link TableBucket}.

## UpdateTableMetadataLocation

Runtime binding for the `UpdateTableMetadataLocation` operation (IAM
action `s3tables:UpdateTableMetadataLocation` on the table ARN).

Commits a new Iceberg metadata file for the bound {@link Table} — the
write half of the Iceberg commit protocol: read the current version with
{@link GetTableMetadataLocation}, write a new metadata file into the
table's warehouse, then commit it here with the observed `versionToken`.
A stale token fails with the typed `ConflictException` (another writer
committed first). Provide the implementation with
`Effect.provide(AWS.S3Tables.UpdateTableMetadataLocationHttp)`.
### The Iceberg Commit Protocol
**Example:** Commit a new metadata file
```typescript
const getTableMetadataLocation =
  yield* AWS.S3Tables.GetTableMetadataLocation(table);
const updateTableMetadataLocation =
  yield* AWS.S3Tables.UpdateTableMetadataLocation(table);

const { versionToken, warehouseLocation } =
  yield* getTableMetadataLocation();
// ... write `${warehouseLocation}/metadata/00001-….metadata.json` ...
yield* updateTableMetadataLocation({
  versionToken,
  metadataLocation: `${warehouseLocation}/metadata/00001-….metadata.json`,
});
```

@binding

## UpdateTableMetadataLocation.Request

`UpdateTableMetadataLocation` request with `tableBucketARN`, `namespace`,
and `name` injected from the bound {@link Table}.
