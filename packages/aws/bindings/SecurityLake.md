<!-- Docs for the generated AWS.SecurityLake bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetDataLakeSources

Runtime binding for `securitylake:GetDataLakeSources`.

Returns a snapshot of which log sources are collecting (per account and
source, with `COLLECTING` / `MISCONFIGURED` / `NOT_COLLECTING` statuses) so
a monitoring Function can verify ingestion health. Bind the account's
{@link DataLake}.
Provide the implementation with
`Effect.provide(AWS.SecurityLake.GetDataLakeSourcesHttp)`.
### Monitoring the data lake
**Example:** Check source collection status
```typescript
// init
const getSources = yield* AWS.SecurityLake.GetDataLakeSources(lake);

// runtime
const { dataLakeSources } = yield* getSources();
```

@binding

## ListDataLakeExceptions

Runtime binding for `securitylake:ListDataLakeExceptions`.

Enumerates the Security Lake exceptions (per-Region failures with
remediation hints) so a monitoring Function can surface or alert on
collection problems. Bind the account's {@link DataLake}.
Provide the implementation with
`Effect.provide(AWS.SecurityLake.ListDataLakeExceptionsHttp)`.
### Monitoring the data lake
**Example:** List current exceptions
```typescript
// init
const listExceptions = yield* AWS.SecurityLake.ListDataLakeExceptions(lake);

// runtime
const { exceptions } = yield* listExceptions();
```

@binding
