<!-- Docs for the generated AWS.Kendra bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchDeleteDocument

Runtime binding for the `BatchDeleteDocument` operation (IAM action
`kendra:BatchDeleteDocument`), scoped to one {@link Index}.

Removes documents from the index by id. Check the response's
`FailedDocuments` for per-document errors.
Provide the implementation with
`Effect.provide(AWS.Kendra.BatchDeleteDocumentHttp)`.

### Indexing Documents
**Example:** Delete Documents
```typescript
const deleteDocuments = yield* AWS.Kendra.BatchDeleteDocument(index);

yield* deleteDocuments({ DocumentIdList: ["welcome"] });
```

@binding

## BatchDeleteDocument.Request

`BatchDeleteDocument` request with `IndexId` injected from the bound index.

## BatchGetDocumentStatus

Runtime binding for the `BatchGetDocumentStatus` operation (IAM action
`kendra:BatchGetDocumentStatus`), scoped to one {@link Index}.

Returns the indexing status (`INDEXED`, `PROCESSING`, `FAILED`, …) of
documents added with {@link BatchPutDocument} or a data-source sync.
Provide the implementation with
`Effect.provide(AWS.Kendra.BatchGetDocumentStatusHttp)`.

### Indexing Documents
**Example:** Check Document Status
```typescript
const documentStatus = yield* AWS.Kendra.BatchGetDocumentStatus(index);

const status = yield* documentStatus({
  DocumentInfoList: [{ DocumentId: "welcome" }],
});
console.log(status.DocumentStatusList?.[0]?.DocumentStatus);
```

@binding

## BatchGetDocumentStatus.Request

`BatchGetDocumentStatus` request with `IndexId` injected from the bound index.

## BatchPutDocument

Runtime binding for the `BatchPutDocument` operation (IAM action
`kendra:BatchPutDocument`), scoped to one {@link Index}.

Adds documents directly to the index (inline blobs or S3 paths) —
the push-API alternative to a data-source sync. Check the response's
`FailedDocuments` for per-document errors; documents index
asynchronously (poll with {@link BatchGetDocumentStatus}).
Provide the implementation with
`Effect.provide(AWS.Kendra.BatchPutDocumentHttp)`.

### Indexing Documents
**Example:** Index Documents Inline
```typescript
const putDocuments = yield* AWS.Kendra.BatchPutDocument(index);

const result = yield* putDocuments({
  Documents: [
    {
      Id: "welcome",
      Title: "Welcome",
      Blob: new TextEncoder().encode("Hello from Alchemy"),
      ContentType: "PLAIN_TEXT",
    },
  ],
});
// result.FailedDocuments is empty on success
```

@binding

## BatchPutDocument.Request

`BatchPutDocument` request with `IndexId` injected from the bound index.

## ClearQuerySuggestions

Runtime binding for the `ClearQuerySuggestions` operation (IAM action
`kendra:ClearQuerySuggestions`), scoped to one {@link Index}.

Clears existing query suggestions for the index. Suggestions rebuild
from new query traffic (which can take up to 24 hours).
Provide the implementation with
`Effect.provide(AWS.Kendra.ClearQuerySuggestionsHttp)`.

### Query Suggestions
**Example:** Reset Suggestions
```typescript
const clearSuggestions = yield* AWS.Kendra.ClearQuerySuggestions(index);

yield* clearSuggestions();
```

@binding

## CreateAccessControlConfiguration

Runtime binding for the `CreateAccessControlConfiguration` operation (IAM action
`kendra:CreateAccessControlConfiguration`), scoped to one {@link Index}.

Creates a named access-control configuration (user/group ACLs) on the
index. Kendra designed this for runtime use: re-apply access changes
to documents at query time without re-indexing them — e.g. revoke a
departed user's access, then reference the returned `Id` from a
document's `AccessControlConfigurationId`.
Provide the implementation with
`Effect.provide(AWS.Kendra.CreateAccessControlConfigurationHttp)`.

### Access Control Configurations
**Example:** Create a Runtime ACL
```typescript
const createAcl =
  yield* AWS.Kendra.CreateAccessControlConfiguration(index);

const { Id } = yield* createAcl({
  Name: "block-departed-users",
  AccessControlList: [
    { Name: "departed-user", Type: "USER", Access: "DENY" },
  ],
});
```

@binding

## CreateAccessControlConfiguration.Request

`CreateAccessControlConfiguration` request with `IndexId` injected from the bound index.

## DeleteAccessControlConfiguration

Runtime binding for the `DeleteAccessControlConfiguration` operation (IAM action
`kendra:DeleteAccessControlConfiguration`), scoped to one {@link Index}.

Deletes an access-control configuration from the index.
Provide the implementation with
`Effect.provide(AWS.Kendra.DeleteAccessControlConfigurationHttp)`.

### Access Control Configurations
**Example:** Delete a Runtime ACL
```typescript
const deleteAcl =
  yield* AWS.Kendra.DeleteAccessControlConfiguration(index);

yield* deleteAcl({ Id: configurationId });
```

@binding

## DeleteAccessControlConfiguration.Request

`DeleteAccessControlConfiguration` request with `IndexId` injected from the bound index.

## DeletePrincipalMapping

Runtime binding for the `DeletePrincipalMapping` operation (IAM action
`kendra:DeletePrincipalMapping`), scoped to one {@link Index}.

Deletes a group's user-to-group mapping created with
{@link PutPrincipalMapping}.
Provide the implementation with
`Effect.provide(AWS.Kendra.DeletePrincipalMappingHttp)`.

### Principal Mapping
**Example:** Remove a Group Mapping
```typescript
const deleteMapping = yield* AWS.Kendra.DeletePrincipalMapping(index);

yield* deleteMapping({ GroupId: "engineering" });
```

@binding

## DeletePrincipalMapping.Request

`DeletePrincipalMapping` request with `IndexId` injected from the bound index.

## DescribeAccessControlConfiguration

Runtime binding for the `DescribeAccessControlConfiguration` operation (IAM action
`kendra:DescribeAccessControlConfiguration`), scoped to one {@link Index}.

Reads one access-control configuration of the index.
Provide the implementation with
`Effect.provide(AWS.Kendra.DescribeAccessControlConfigurationHttp)`.

### Access Control Configurations
**Example:** Describe a Runtime ACL
```typescript
const describeAcl =
  yield* AWS.Kendra.DescribeAccessControlConfiguration(index);

const acl = yield* describeAcl({ Id: configurationId });
console.log(acl.Name, acl.AccessControlList);
```

@binding

## DescribeAccessControlConfiguration.Request

`DescribeAccessControlConfiguration` request with `IndexId` injected from the bound index.

## DescribePrincipalMapping

Runtime binding for the `DescribePrincipalMapping` operation (IAM action
`kendra:DescribePrincipalMapping`), scoped to one {@link Index}.

Describes the processing state of the `PUT`/`DELETE` actions applied
to a group's principal mapping.
Provide the implementation with
`Effect.provide(AWS.Kendra.DescribePrincipalMappingHttp)`.

### Principal Mapping
**Example:** Inspect Mapping Actions
```typescript
const describeMapping = yield* AWS.Kendra.DescribePrincipalMapping(index);

const mapping = yield* describeMapping({ GroupId: "engineering" });
console.log(mapping.GroupOrderingIdSummaries);
```

@binding

## DescribePrincipalMapping.Request

`DescribePrincipalMapping` request with `IndexId` injected from the bound index.

## DescribeQuerySuggestionsConfig

Runtime binding for the `DescribeQuerySuggestionsConfig` operation (IAM action
`kendra:DescribeQuerySuggestionsConfig`), scoped to one {@link Index}.

Reads the index's query-suggestions settings (mode, query-log look-back
window, attribute-suggestions config, …).
Provide the implementation with
`Effect.provide(AWS.Kendra.DescribeQuerySuggestionsConfigHttp)`.

### Query Suggestions
**Example:** Read Suggestions Settings
```typescript
const suggestionsConfig =
  yield* AWS.Kendra.DescribeQuerySuggestionsConfig(index);

const config = yield* suggestionsConfig();
console.log(config.Mode, config.Status);
```

@binding

## GetQuerySuggestions

Runtime binding for the `GetQuerySuggestions` operation (IAM action
`kendra:GetQuerySuggestions`), scoped to one {@link Index}.

Fetches typeahead query suggestions for a partial query string, based
on the index's query history and/or document fields.
Provide the implementation with
`Effect.provide(AWS.Kendra.GetQuerySuggestionsHttp)`.

### Query Suggestions
**Example:** Typeahead Suggestions
```typescript
const suggest = yield* AWS.Kendra.GetQuerySuggestions(index);

const { Suggestions } = yield* suggest({ QueryText: "how to conf" });
```

@binding

## GetQuerySuggestions.Request

`GetQuerySuggestions` request with `IndexId` injected from the bound index.

## GetSnapshots

Runtime binding for the `GetSnapshots` operation (IAM action
`kendra:GetSnapshots`), scoped to one {@link Index}.

Fetches search-analytics metric snapshots for the index (click-through
rate, zero-result queries, top queries, …) over a time interval.
Provide the implementation with
`Effect.provide(AWS.Kendra.GetSnapshotsHttp)`.

### Search Analytics
**Example:** Fetch Search Metrics
```typescript
const getSnapshots = yield* AWS.Kendra.GetSnapshots(index);

const metrics = yield* getSnapshots({
  Interval: "ONE_WEEK_AGO",
  MetricType: "QUERIES_BY_COUNT",
});
```

@binding

## GetSnapshots.Request

`GetSnapshots` request with `IndexId` injected from the bound index.

## ListAccessControlConfigurations

Runtime binding for the `ListAccessControlConfigurations` operation (IAM action
`kendra:ListAccessControlConfigurations`), scoped to one {@link Index}.

Lists the index's access-control configurations.
Provide the implementation with
`Effect.provide(AWS.Kendra.ListAccessControlConfigurationsHttp)`.

### Access Control Configurations
**Example:** List Runtime ACLs
```typescript
const listAcls =
  yield* AWS.Kendra.ListAccessControlConfigurations(index);

const { AccessControlConfigurations } = yield* listAcls();
```

@binding

## ListAccessControlConfigurations.Request

`ListAccessControlConfigurations` request with `IndexId` injected from the bound index.

## ListDataSourceSyncJobs

Runtime binding for the `ListDataSourceSyncJobs` operation (IAM action
`kendra:ListDataSourceSyncJobs`), scoped to one {@link DataSource}.

Lists the data source's sync-job history — status, error details, and
per-run document add/modify/delete/fail metrics.
Provide the implementation with
`Effect.provide(AWS.Kendra.ListDataSourceSyncJobsHttp)`.

### Syncing Data Sources
**Example:** Sync Job History
```typescript
const listSyncJobs = yield* AWS.Kendra.ListDataSourceSyncJobs(source);

const jobs = yield* listSyncJobs({ StatusFilter: "SUCCEEDED" });
console.log(jobs.History?.[0]?.Metrics);
```

@binding

## ListDataSourceSyncJobs.Request

`ListDataSourceSyncJobs` request with `Id` and `IndexId` injected from the bound data source.

## ListGroupsOlderThanOrderingId

Runtime binding for the `ListGroupsOlderThanOrderingId` operation (IAM action
`kendra:ListGroupsOlderThanOrderingId`), scoped to one {@link Index}.

Lists groups whose principal mapping is older than the given ordering
id — used to find stale group mappings to refresh or delete.
Provide the implementation with
`Effect.provide(AWS.Kendra.ListGroupsOlderThanOrderingIdHttp)`.

### Principal Mapping
**Example:** List Stale Groups
```typescript
const listGroups = yield* AWS.Kendra.ListGroupsOlderThanOrderingId(index);

const stale = yield* listGroups({ OrderingId: orderingId });
console.log(stale.GroupsSummaries);
```

@binding

## ListGroupsOlderThanOrderingId.Request

`ListGroupsOlderThanOrderingId` request with `IndexId` injected from the bound index.

## PutPrincipalMapping

Runtime binding for the `PutPrincipalMapping` operation (IAM action
`kendra:PutPrincipalMapping`), scoped to one {@link Index}.

Maps users to groups (optionally per data source) so queries filtered
on the user's context only return documents that user's groups may
access.
Provide the implementation with
`Effect.provide(AWS.Kendra.PutPrincipalMappingHttp)`.

### Principal Mapping
**Example:** Map Users to a Group
```typescript
const putPrincipalMapping = yield* AWS.Kendra.PutPrincipalMapping(index);

yield* putPrincipalMapping({
  GroupId: "engineering",
  GroupMembers: {
    MemberUsers: [{ UserId: "user@example.com" }],
  },
});
```

@binding

## PutPrincipalMapping.Request

`PutPrincipalMapping` request with `IndexId` injected from the bound index.

## Query

Runtime binding for the `Query` operation (IAM action
`kendra:Query`), scoped to one {@link Index}.

Searches the index with a natural-language query — returns ranked
answers, FAQ matches, and document results, optionally filtered on
document attributes and the querying user's context.
Provide the implementation with
`Effect.provide(AWS.Kendra.QueryHttp)`.

### Querying an Index
**Example:** Search an Index
```typescript
const query = yield* AWS.Kendra.Query(index);

const results = yield* query({ QueryText: "how do I configure SSO?" });
for (const item of results.ResultItems ?? []) {
  console.log(item.Type, item.DocumentTitle?.Text);
}
```

@binding

## Query.Request

`Query` request with `IndexId` injected from the bound index.

## Retrieve

Runtime binding for the `Retrieve` operation (IAM action
`kendra:Retrieve`), scoped to one {@link Index}.

Retrieves up to 100 semantically-relevant passages (200-token excerpts)
from the index — the building block for retrieval-augmented generation
(RAG) over documents synced into Kendra.
Provide the implementation with
`Effect.provide(AWS.Kendra.RetrieveHttp)`.

### Querying an Index
**Example:** Retrieve Passages for RAG
```typescript
const retrieve = yield* AWS.Kendra.Retrieve(index);

const passages = yield* retrieve({ QueryText: "vacation policy" });
const context = (passages.ResultItems ?? [])
  .map((item) => item.Content)
  .join("\n");
```

@binding

## Retrieve.Request

`Retrieve` request with `IndexId` injected from the bound index.

## StartDataSourceSyncJob

Runtime binding for the `StartDataSourceSyncJob` operation (IAM action
`kendra:StartDataSourceSyncJob`), scoped to one {@link DataSource}.

Starts an on-demand sync of the data source into its index — the
programmatic alternative to the data source's cron `schedule`. Fails
with `ResourceInUseException` while another sync is already running.
Provide the implementation with
`Effect.provide(AWS.Kendra.StartDataSourceSyncJobHttp)`.

### Syncing Data Sources
**Example:** Trigger a Sync
```typescript
const startSync = yield* AWS.Kendra.StartDataSourceSyncJob(source);

const { ExecutionId } = yield* startSync();
```

@binding

## StopDataSourceSyncJob

Runtime binding for the `StopDataSourceSyncJob` operation (IAM action
`kendra:StopDataSourceSyncJob`), scoped to one {@link DataSource}.

Stops the data source's currently-running sync job, if any.
Provide the implementation with
`Effect.provide(AWS.Kendra.StopDataSourceSyncJobHttp)`.

### Syncing Data Sources
**Example:** Stop a Running Sync
```typescript
const stopSync = yield* AWS.Kendra.StopDataSourceSyncJob(source);

yield* stopSync();
```

@binding

## SubmitFeedback

Runtime binding for the `SubmitFeedback` operation (IAM action
`kendra:SubmitFeedback`), scoped to one {@link Index}.

Submits click and relevance feedback for a query's results — Kendra
uses it to tune the index's relevance over time (incremental learning).
Provide the implementation with
`Effect.provide(AWS.Kendra.SubmitFeedbackHttp)`.

### Querying an Index
**Example:** Submit Click Feedback
```typescript
const submitFeedback = yield* AWS.Kendra.SubmitFeedback(index);

yield* submitFeedback({
  QueryId: queryId,
  ClickFeedbackItems: [{ ResultId: resultId, ClickTime: new Date() }],
});
```

@binding

## SubmitFeedback.Request

`SubmitFeedback` request with `IndexId` injected from the bound index.

## UpdateAccessControlConfiguration

Runtime binding for the `UpdateAccessControlConfiguration` operation (IAM action
`kendra:UpdateAccessControlConfiguration`), scoped to one {@link Index}.

Updates an access-control configuration's name, description, or
user/group ACLs.
Provide the implementation with
`Effect.provide(AWS.Kendra.UpdateAccessControlConfigurationHttp)`.

### Access Control Configurations
**Example:** Update a Runtime ACL
```typescript
const updateAcl =
  yield* AWS.Kendra.UpdateAccessControlConfiguration(index);

yield* updateAcl({
  Id: configurationId,
  AccessControlList: [{ Name: "sam", Type: "USER", Access: "ALLOW" }],
});
```

@binding

## UpdateAccessControlConfiguration.Request

`UpdateAccessControlConfiguration` request with `IndexId` injected from the bound index.
