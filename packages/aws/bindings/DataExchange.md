<!-- Docs for the generated AWS.DataExchange bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AcceptDataGrant

Runtime binding for `dataexchange:AcceptDataGrant`.

Accepts a data grant another account sent to this account, creating
an entitled copy of the granted data set — the receiver-side
automation of direct data sharing.
Provide the implementation with
`Effect.provide(AWS.DataExchange.AcceptDataGrantHttp)`.
### Data Grants
**Example:** Accept An Incoming Grant
```typescript
const acceptDataGrant = yield* AWS.DataExchange.AcceptDataGrant();

// runtime
const accepted = yield* acceptDataGrant({ DataGrantArn: grantArn });
yield* Effect.log(`entitled data set: ${accepted.DataSetId}`);
```

@binding

## CancelJob

Runtime binding for `dataexchange:CancelJob`.

Cancels a job that has not yet been started (`WAITING` state).
Provide the implementation with
`Effect.provide(AWS.DataExchange.CancelJobHttp)`.
### Import & Export Jobs
**Example:** Cancel A Waiting Job
```typescript
const cancelJob = yield* AWS.DataExchange.CancelJob();

// runtime
yield* cancelJob({ JobId: job.Id! });
```

@binding

## CreateDataGrant

Runtime binding for `dataexchange:CreateDataGrant`.

Creates a data grant sharing an owned data set with another AWS
account directly (without an AWS Marketplace product). The receiver
must accept the grant to get an entitled copy of the data set.
Provide the implementation with
`Effect.provide(AWS.DataExchange.CreateDataGrantHttp)`.
### Data Grants
**Example:** Grant A Data Set To Another Account
```typescript
const createDataGrant = yield* AWS.DataExchange.CreateDataGrant();

// runtime
const grant = yield* createDataGrant({
  Name: "prices-for-analytics",
  SourceDataSetId: dataSetId,
  ReceiverPrincipal: "111122223333",
  GrantDistributionScope: "NONE",
});
```

@binding

## CreateJob

Runtime binding for `dataexchange:CreateJob`.

Creates an import/export job — the Data Exchange work unit that moves
assets between S3 (or signed URLs, Redshift datashares, API Gateway
APIs, Lake Formation permissions) and a revision. Import/export jobs
additionally need S3 permissions on the source/destination bucket —
attach the matching `AWS.S3` bindings to the same host.
Provide the implementation with
`Effect.provide(AWS.DataExchange.CreateJobHttp)`.
### Import & Export Jobs
**Example:** Import S3 Objects Into A Revision
```typescript
const createJob = yield* AWS.DataExchange.CreateJob();
const startJob = yield* AWS.DataExchange.StartJob();

// runtime
const job = yield* createJob({
  Type: "IMPORT_ASSETS_FROM_S3",
  Details: {
    ImportAssetsFromS3: {
      DataSetId: dataSetId,
      RevisionId: revisionId,
      AssetSources: [{ Bucket: bucket, Key: "prices.csv" }],
    },
  },
});
yield* startJob({ JobId: job.Id! });
```

@binding

## DeleteAsset

Runtime binding for `dataexchange:DeleteAsset`.

Deletes an asset from the bound (not-yet-finalized) revision. The
data set and revision ids are injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataExchange.DeleteAssetHttp)`.
### Managing Assets
**Example:** Remove A Bad Import
```typescript
const deleteAsset = yield* AWS.DataExchange.DeleteAsset(revision);

// runtime
yield* deleteAsset({ AssetId: assetId });
```

@binding

## DeleteDataGrant

Runtime binding for `dataexchange:DeleteDataGrant`.

Deletes a sent data grant, revoking the receiver's entitlement.
Provide the implementation with
`Effect.provide(AWS.DataExchange.DeleteDataGrantHttp)`.
### Data Grants
**Example:** Revoke A Sent Grant
```typescript
const deleteDataGrant = yield* AWS.DataExchange.DeleteDataGrant();

// runtime
yield* deleteDataGrant({ DataGrantId: grantId });
```

@binding

## GetAsset

Runtime binding for `dataexchange:GetAsset`.

Reads one asset of the bound revision — name, type-specific details
(S3 snapshot size, API Gateway endpoint, …), and timestamps. The data
set and revision ids are injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataExchange.GetAssetHttp)`.
### Reading Revisions & Assets
**Example:** Read An Asset's Detail
```typescript
const getAsset = yield* AWS.DataExchange.GetAsset(revision);

// runtime
const asset = yield* getAsset({ AssetId: assetId });
yield* Effect.log(`asset ${asset.Name}`);
```

@binding

## GetDataGrant

Runtime binding for `dataexchange:GetDataGrant`.

Reads a sent data grant's detail — receiver, acceptance state, and
expiration.
Provide the implementation with
`Effect.provide(AWS.DataExchange.GetDataGrantHttp)`.
### Data Grants
**Example:** Check A Grant's Acceptance State
```typescript
const getDataGrant = yield* AWS.DataExchange.GetDataGrant();

// runtime
const grant = yield* getDataGrant({ DataGrantId: grantId });
yield* Effect.log(`state: ${grant.AcceptanceState}`);
```

@binding

## GetDataSet

Runtime binding for `dataexchange:GetDataSet`.

Reads the bound data set's detail — name, description, asset type,
origin (`OWNED` or `ENTITLED`), and origin details. The data set id is
injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataExchange.GetDataSetHttp)`.
### Reading Data Sets
**Example:** Read The Bound Data Set
```typescript
// init — bind the operation to the data set
const getDataSet = yield* AWS.DataExchange.GetDataSet(dataSet);

// runtime
const detail = yield* getDataSet();
yield* Effect.log(`data set ${detail.Name} (${detail.AssetType})`);
```

@binding

## GetJob

Runtime binding for `dataexchange:GetJob`.

Reads a job's state (`WAITING`, `IN_PROGRESS`, `COMPLETED`, `ERROR`,
…) and typed error details — the polling half of every import/export
flow.
Provide the implementation with
`Effect.provide(AWS.DataExchange.GetJobHttp)`.
### Import & Export Jobs
**Example:** Poll A Job Until It Completes
```typescript
const getJob = yield* AWS.DataExchange.GetJob();

// runtime
const done = yield* getJob({ JobId: job.Id! }).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("2 seconds"),
    until: (j) => j.State === "COMPLETED" || j.State === "ERROR",
    times: 30,
  }),
);
```

@binding

## GetReceivedDataGrant

Runtime binding for `dataexchange:GetReceivedDataGrant`.

Reads a received data grant's detail — sender, acceptance state, and
expiration.
Provide the implementation with
`Effect.provide(AWS.DataExchange.GetReceivedDataGrantHttp)`.
### Data Grants
**Example:** Inspect A Received Grant
```typescript
const getReceivedDataGrant =
  yield* AWS.DataExchange.GetReceivedDataGrant();

// runtime
const grant = yield* getReceivedDataGrant({ DataGrantArn: grantArn });
```

@binding

## GetRevision

Runtime binding for `dataexchange:GetRevision`.

Reads the bound revision's detail — comment, finalized state, and
revocation status. The data set and revision ids are injected from
the binding.
Provide the implementation with
`Effect.provide(AWS.DataExchange.GetRevisionHttp)`.
### Reading Revisions & Assets
**Example:** Check A Revision's State
```typescript
const getRevision = yield* AWS.DataExchange.GetRevision(revision);

// runtime
const detail = yield* getRevision();
yield* Effect.log(`finalized: ${detail.Finalized}`);
```

@binding

## ListDataGrants

Runtime binding for `dataexchange:ListDataGrants`.

Enumerates the data grants this account has sent.
Provide the implementation with
`Effect.provide(AWS.DataExchange.ListDataGrantsHttp)`.
### Data Grants
**Example:** List Sent Grants
```typescript
const listDataGrants = yield* AWS.DataExchange.ListDataGrants();

// runtime
const { DataGrantSummaries } = yield* listDataGrants();
```

@binding

## ListDataSetRevisions

Runtime binding for `dataexchange:ListDataSetRevisions`.

Enumerates the bound data set's revisions, newest first — the
building block of "process the latest published revision" consumers.
The data set id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataExchange.ListDataSetRevisionsHttp)`.
### Reading Data Sets
**Example:** Find The Latest Finalized Revision
```typescript
const listRevisions = yield* AWS.DataExchange.ListDataSetRevisions(dataSet);

// runtime
const { Revisions } = yield* listRevisions();
const latest = (Revisions ?? []).find((r) => r.Finalized);
```

@binding

## ListDataSets

Runtime binding for `dataexchange:ListDataSets`.

Enumerates the account's data sets — `Origin: "OWNED"` for data sets
this account publishes, `Origin: "ENTITLED"` for active
subscriptions.
Provide the implementation with
`Effect.provide(AWS.DataExchange.ListDataSetsHttp)`.
### Reading Data Sets
**Example:** List Entitled Data Sets
```typescript
// init — account-level binding, no resource argument
const listDataSets = yield* AWS.DataExchange.ListDataSets();

// runtime
const { DataSets } = yield* listDataSets({ Origin: "ENTITLED" });
```

@binding

## ListEventActions

Runtime binding for `dataexchange:ListEventActions`.

Enumerates the account's event actions (auto-export rules on entitled
data sets), optionally filtered to one event source data set.
Provide the implementation with
`Effect.provide(AWS.DataExchange.ListEventActionsHttp)`.
### Event Actions
**Example:** List Auto-Export Rules
```typescript
const listEventActions = yield* AWS.DataExchange.ListEventActions();

// runtime
const { EventActions } = yield* listEventActions();
```

@binding

## ListJobs

Runtime binding for `dataexchange:ListJobs`.

Enumerates the account's import/export jobs, optionally filtered to
one data set or revision.
Provide the implementation with
`Effect.provide(AWS.DataExchange.ListJobsHttp)`.
### Import & Export Jobs
**Example:** List A Data Set's Jobs
```typescript
const listJobs = yield* AWS.DataExchange.ListJobs();

// runtime
const { Jobs } = yield* listJobs({ DataSetId: dataSetId });
```

@binding

## ListReceivedDataGrants

Runtime binding for `dataexchange:ListReceivedDataGrants`.

Enumerates the data grants this account has received, optionally
filtered by acceptance state (`PENDING_RECEIVER_ACCEPTANCE`,
`ACCEPTED`).
Provide the implementation with
`Effect.provide(AWS.DataExchange.ListReceivedDataGrantsHttp)`.
### Data Grants
**Example:** Find Pending Grants
```typescript
const listReceivedDataGrants =
  yield* AWS.DataExchange.ListReceivedDataGrants();

// runtime
const { DataGrantSummaries } = yield* listReceivedDataGrants({
  AcceptanceState: ["PENDING_RECEIVER_ACCEPTANCE"],
});
```

@binding

## ListRevisionAssets

Runtime binding for `dataexchange:ListRevisionAssets`.

Enumerates the assets imported into the bound revision. The data set
and revision ids are injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataExchange.ListRevisionAssetsHttp)`.
### Reading Revisions & Assets
**Example:** List A Revision's Assets
```typescript
const listAssets = yield* AWS.DataExchange.ListRevisionAssets(revision);

// runtime
const { Assets } = yield* listAssets();
yield* Effect.log(`${(Assets ?? []).length} assets`);
```

@binding

## RevokeRevision

Runtime binding for `dataexchange:RevokeRevision`.

Revokes the bound revision from subscribers with a required
revocation comment — the remediation path when bad or sensitive data
was published. The data set and revision ids are injected from the
binding.
Provide the implementation with
`Effect.provide(AWS.DataExchange.RevokeRevisionHttp)`.
### Managing Assets
**Example:** Revoke A Published Revision
```typescript
const revokeRevision = yield* AWS.DataExchange.RevokeRevision(revision);

// runtime
yield* revokeRevision({
  RevocationComment: "Published with corrupted price data",
});
```

@binding

## SendApiAsset

Runtime binding for `dataexchange:SendApiAsset`.

Invokes an API asset of an entitled `API_GATEWAY_API` data set — the
Data Exchange data plane proxies the request to the provider's API
Gateway. The data set id is injected from the binding; pass the
revision and asset ids of the API asset to call.
Provide the implementation with
`Effect.provide(AWS.DataExchange.SendApiAssetHttp)`.
### Calling API Assets
**Example:** Call A Subscribed API Asset
```typescript
const sendApiAsset = yield* AWS.DataExchange.SendApiAsset(dataSet);

// runtime
const response = yield* sendApiAsset({
  RevisionId: revisionId,
  AssetId: assetId,
  Method: "GET",
  Path: "/prices",
});
```

@binding

## SendDataSetNotification

Runtime binding for `dataexchange:SendDataSetNotification`.

Sends a provider-generated notification about the bound data set to
its subscribers (`DATA_UPDATE`, `DATA_DELAY`, `SCHEMA_CHANGE`, or
`DEPRECATION`) — delivered to each subscriber's default EventBridge
bus. The data set id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataExchange.SendDataSetNotificationHttp)`.
### Notifying Subscribers
**Example:** Announce A Data Update
```typescript
const notify = yield* AWS.DataExchange.SendDataSetNotification(dataSet);

// runtime — after publishing a new revision
yield* notify({ Type: "DATA_UPDATE", Comment: "Daily prices refreshed" });
```

@binding

## UpdateAsset

Runtime binding for `dataexchange:UpdateAsset`.

Renames an asset of the bound revision (the asset name is the S3 key
used when subscribers export it). The data set and revision ids are
injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataExchange.UpdateAssetHttp)`.
### Managing Assets
**Example:** Rename An Imported Asset
```typescript
const updateAsset = yield* AWS.DataExchange.UpdateAsset(revision);

// runtime
yield* updateAsset({ AssetId: assetId, Name: "prices/2026-07-14.csv" });
```

@binding
