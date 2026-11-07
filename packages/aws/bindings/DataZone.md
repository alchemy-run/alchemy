<!-- Docs for the generated AWS.DataZone bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AcceptPredictions

Runtime binding for `datazone:AcceptPredictions`.

Accepts ML-generated metadata predictions (business-name suggestions) on an asset in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.AcceptPredictionsHttp)`.
### Publishing Assets
**Example:** Accept All Predictions
```typescript
// init — bind the operation to the domain
const acceptPredictions = yield* AWS.DataZone.AcceptPredictions(domain);

// runtime
yield* acceptPredictions({ identifier: assetId, acceptRule: { rule: "ALL" } });
```

@binding

## AcceptSubscriptionRequest

Runtime binding for `datazone:AcceptSubscriptionRequest`.

Approves a pending subscription request in the bound domain — the core of an automated approval workflow. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.AcceptSubscriptionRequestHttp)`.
### Subscription Workflows
**Example:** Auto-approve a Request
```typescript
// init — bind the operation to the domain
const acceptSubscriptionRequest = yield* AWS.DataZone.AcceptSubscriptionRequest(domain);

// runtime
yield* acceptSubscriptionRequest({ identifier: requestId, decisionComment: "auto-approved" });
```

@binding

## CancelSubscription

Runtime binding for `datazone:CancelSubscription`.

Cancels a subscription in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.CancelSubscriptionHttp)`.
### Subscription Workflows
**Example:** Cancel a Subscription
```typescript
// init — bind the operation to the domain
const cancelSubscription = yield* AWS.DataZone.CancelSubscription(domain);

// runtime
yield* cancelSubscription({ identifier: subscriptionId });
```

@binding

## CreateAsset

Runtime binding for `datazone:CreateAsset`.

Creates an asset in the bound domain's inventory, e.g. to register data produced by the function itself. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.CreateAssetHttp)`.
### Publishing Assets
**Example:** Register an Asset
```typescript
// init — bind the operation to the domain
const createAsset = yield* AWS.DataZone.CreateAsset(domain);

// runtime
const asset = yield* createAsset({
  name: "daily-orders",
  typeIdentifier: "amazon.datazone.S3ObjectCollectionAssetType",
  owningProjectIdentifier: projectId,
});
```

@binding

## CreateAssetRevision

Runtime binding for `datazone:CreateAssetRevision`.

Creates a new revision of an existing asset in the bound domain, e.g. after a schema change. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.CreateAssetRevisionHttp)`.
### Publishing Assets
**Example:** Revise an Asset
```typescript
// init — bind the operation to the domain
const createAssetRevision = yield* AWS.DataZone.CreateAssetRevision(domain);

// runtime
yield* createAssetRevision({ identifier: assetId, name: "daily-orders" });
```

@binding

## CreateSubscriptionRequest

Runtime binding for `datazone:CreateSubscriptionRequest`.

Requests a subscription to a published listing in the bound domain on behalf of a project. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.CreateSubscriptionRequestHttp)`.
### Subscription Workflows
**Example:** Request Access to a Listing
```typescript
// init — bind the operation to the domain
const createSubscriptionRequest = yield* AWS.DataZone.CreateSubscriptionRequest(domain);

// runtime
yield* createSubscriptionRequest({
  subscribedPrincipals: [{ project: { identifier: projectId } }],
  subscribedListings: [{ identifier: listingId }],
  requestReason: "nightly enrichment job needs read access",
});
```

@binding

## GetAsset

Runtime binding for `datazone:GetAsset`.

Reads an asset in the bound domain — its forms, glossary terms, and latest revision. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.GetAssetHttp)`.
### Searching the Catalog
**Example:** Read an Asset
```typescript
// init — bind the operation to the domain
const getAsset = yield* AWS.DataZone.GetAsset(domain);

// runtime
const asset = yield* getAsset({ identifier: assetId });
```

@binding

## GetDataSourceRun

Runtime binding for `datazone:GetDataSourceRun`.

Reads the status of a data source run in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.GetDataSourceRunHttp)`.
### Data Source Runs
**Example:** Poll a Run to Completion
```typescript
// init — bind the operation to the domain
const getDataSourceRun = yield* AWS.DataZone.GetDataSourceRun(domain);

// runtime
const run = yield* getDataSourceRun({ identifier: runId });
if (run.status === "FAILED") { yield* Effect.logError(run.errorMessage); }
```

@binding

## GetEnvironmentCredentials

Runtime binding for `datazone:GetEnvironmentCredentials`.

Fetches the short-lived AWS credentials of the bound environment's provisioned user role. The `secretAccessKey` and `sessionToken` are `Redacted` — unwrap with `Redacted.value` only at the point of use. The domain and environment ids are injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.GetEnvironmentCredentialsHttp)`.
### Environment Credentials
**Example:** Assume the Environment's Role
```typescript
// init — bind the operation to the environment
const getEnvironmentCredentials = yield* AWS.DataZone.GetEnvironmentCredentials(environment);

// runtime
const creds = yield* getEnvironmentCredentials();
const secret = Redacted.value(creds.secretAccessKey!);
```

@binding

## GetIamPortalLoginUrl

Runtime binding for `datazone:GetIamPortalLoginUrl`.

Mints a single-use data portal sign-in URL for the bound domain, e.g. to embed in a notification. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.GetIamPortalLoginUrlHttp)`.
### Portal, Profiles & Notifications
**Example:** Mint a Portal URL
```typescript
// init — bind the operation to the domain
const getIamPortalLoginUrl = yield* AWS.DataZone.GetIamPortalLoginUrl(domain);

// runtime
const { authCodeUrl } = yield* getIamPortalLoginUrl();
```

@binding

## GetLineageNode

Runtime binding for `datazone:GetLineageNode`.

Reads a data lineage node in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.GetLineageNodeHttp)`.
### Data Lineage
**Example:** Read a Lineage Node
```typescript
// init — bind the operation to the domain
const getLineageNode = yield* AWS.DataZone.GetLineageNode(domain);

// runtime
const node = yield* getLineageNode({ identifier: nodeId });
```

@binding

## GetListing

Runtime binding for `datazone:GetListing`.

Reads a published listing in the bound domain by id. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.GetListingHttp)`.
### Searching the Catalog
**Example:** Read a Listing
```typescript
// init — bind the operation to the domain
const getListing = yield* AWS.DataZone.GetListing(domain);

// runtime
const listing = yield* getListing({ identifier: listingId });
```

@binding

## GetMetadataGenerationRun

Runtime binding for `datazone:GetMetadataGenerationRun`.

Reads the status of a metadata generation run in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.GetMetadataGenerationRunHttp)`.
### Metadata Generation
**Example:** Check a Generation Run
```typescript
// init — bind the operation to the domain
const getMetadataGenerationRun = yield* AWS.DataZone.GetMetadataGenerationRun(domain);

// runtime
const run = yield* getMetadataGenerationRun({ identifier: runId });
```

@binding

## GetSubscription

Runtime binding for `datazone:GetSubscription`.

Reads a subscription in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.GetSubscriptionHttp)`.
### Subscription Workflows
**Example:** Read a Subscription
```typescript
// init — bind the operation to the domain
const getSubscription = yield* AWS.DataZone.GetSubscription(domain);

// runtime
const sub = yield* getSubscription({ identifier: subscriptionId });
```

@binding

## GetTimeSeriesDataPoint

Runtime binding for `datazone:GetTimeSeriesDataPoint`.

Reads a single time series data point on an asset or listing in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.GetTimeSeriesDataPointHttp)`.
### Time Series Metadata
**Example:** Read One Data Point
```typescript
// init — bind the operation to the domain
const getTimeSeriesDataPoint = yield* AWS.DataZone.GetTimeSeriesDataPoint(domain);

// runtime
const point = yield* getTimeSeriesDataPoint({
  entityIdentifier: assetId,
  entityType: "ASSET",
  formName: "quality",
  identifier: dataPointId,
});
```

@binding

## GetUserProfile

Runtime binding for `datazone:GetUserProfile`.

Reads a user profile in the bound domain — e.g. to resolve the requester of a subscription request. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.GetUserProfileHttp)`.
### Portal, Profiles & Notifications
**Example:** Resolve a User Profile
```typescript
// init — bind the operation to the domain
const getUserProfile = yield* AWS.DataZone.GetUserProfile(domain);

// runtime
const profile = yield* getUserProfile({ userIdentifier: userId });
```

@binding

## ListDataSourceRuns

Runtime binding for `datazone:ListDataSourceRuns`.

Lists the runs of a data source in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.ListDataSourceRunsHttp)`.
### Data Source Runs
**Example:** List Recent Runs
```typescript
// init — bind the operation to the domain
const listDataSourceRuns = yield* AWS.DataZone.ListDataSourceRuns(domain);

// runtime
const runs = yield* listDataSourceRuns({ dataSourceIdentifier: dataSourceId });
```

@binding

## ListNotifications

Runtime binding for `datazone:ListNotifications`.

Lists task or event notifications for the calling user in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.ListNotificationsHttp)`.
### Portal, Profiles & Notifications
**Example:** Read Pending Tasks
```typescript
// init — bind the operation to the domain
const listNotifications = yield* AWS.DataZone.ListNotifications(domain);

// runtime
const tasks = yield* listNotifications({ type: "TASK", taskStatus: "ACTIVE" });
```

@binding

## ListSubscriptionRequests

Runtime binding for `datazone:ListSubscriptionRequests`.

Lists subscription requests in the bound domain, optionally by status — e.g. the PENDING queue an approval bot works through. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.ListSubscriptionRequestsHttp)`.
### Subscription Workflows
**Example:** List Pending Requests
```typescript
// init — bind the operation to the domain
const listSubscriptionRequests = yield* AWS.DataZone.ListSubscriptionRequests(domain);

// runtime
const pending = yield* listSubscriptionRequests({ status: "PENDING" });
```

@binding

## ListSubscriptions

Runtime binding for `datazone:ListSubscriptions`.

Lists subscriptions in the bound domain, optionally by status. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.ListSubscriptionsHttp)`.
### Subscription Workflows
**Example:** List Approved Subscriptions
```typescript
// init — bind the operation to the domain
const listSubscriptions = yield* AWS.DataZone.ListSubscriptions(domain);

// runtime
const subs = yield* listSubscriptions({ status: "APPROVED" });
```

@binding

## ListTimeSeriesDataPoints

Runtime binding for `datazone:ListTimeSeriesDataPoints`.

Lists time series data points recorded on an asset or listing in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.ListTimeSeriesDataPointsHttp)`.
### Time Series Metadata
**Example:** Read Back Metric History
```typescript
// init — bind the operation to the domain
const listTimeSeriesDataPoints = yield* AWS.DataZone.ListTimeSeriesDataPoints(domain);

// runtime
const points = yield* listTimeSeriesDataPoints({
  entityIdentifier: assetId,
  entityType: "ASSET",
  formName: "quality",
});
```

@binding

## PostLineageEvent

Runtime binding for `datazone:PostLineageEvent`.

Posts an OpenLineage run event to the bound domain, recording the lineage of a data transformation the function performed. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.PostLineageEventHttp)`.
### Data Lineage
**Example:** Emit a Lineage Event
```typescript
// init — bind the operation to the domain
const postLineageEvent = yield* AWS.DataZone.PostLineageEvent(domain);

// runtime
yield* postLineageEvent({ event: JSON.stringify(openLineageRunEvent) });
```

@binding

## PostTimeSeriesDataPoints

Runtime binding for `datazone:PostTimeSeriesDataPoints`.

Posts time series data points (e.g. data-quality metrics) onto an asset or listing in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.PostTimeSeriesDataPointsHttp)`.
### Time Series Metadata
**Example:** Record Data Quality Metrics
```typescript
// init — bind the operation to the domain
const postTimeSeriesDataPoints = yield* AWS.DataZone.PostTimeSeriesDataPoints(domain);

// runtime
yield* postTimeSeriesDataPoints({
  entityIdentifier: assetId,
  entityType: "ASSET",
  forms: [{ formName: "quality", typeIdentifier: "amazon.datazone.DataQualityResultFormType", content: "{}", timestamp: new Date() }],
});
```

@binding

## RejectPredictions

Runtime binding for `datazone:RejectPredictions`.

Rejects ML-generated metadata predictions on an asset in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.RejectPredictionsHttp)`.
### Publishing Assets
**Example:** Reject All Predictions
```typescript
// init — bind the operation to the domain
const rejectPredictions = yield* AWS.DataZone.RejectPredictions(domain);

// runtime
yield* rejectPredictions({ identifier: assetId, rejectRule: { rule: "ALL" } });
```

@binding

## RejectSubscriptionRequest

Runtime binding for `datazone:RejectSubscriptionRequest`.

Rejects a pending subscription request in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.RejectSubscriptionRequestHttp)`.
### Subscription Workflows
**Example:** Reject a Request
```typescript
// init — bind the operation to the domain
const rejectSubscriptionRequest = yield* AWS.DataZone.RejectSubscriptionRequest(domain);

// runtime
yield* rejectSubscriptionRequest({ identifier: requestId, decisionComment: "PII policy" });
```

@binding

## RevokeSubscription

Runtime binding for `datazone:RevokeSubscription`.

Revokes an approved subscription in the bound domain, optionally retaining already-granted permissions. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.RevokeSubscriptionHttp)`.
### Subscription Workflows
**Example:** Revoke a Subscription
```typescript
// init — bind the operation to the domain
const revokeSubscription = yield* AWS.DataZone.RevokeSubscription(domain);

// runtime
yield* revokeSubscription({ identifier: subscriptionId, retainPermissions: false });
```

@binding

## Search

Runtime binding for `datazone:Search`.

Searches the bound domain's inventory — assets, glossaries, and data products visible to the calling project. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.SearchHttp)`.
### Searching the Catalog
**Example:** Search Assets by Text
```typescript
// init — bind the operation to the domain
const search = yield* AWS.DataZone.Search(domain);

// runtime
const result = yield* search({ searchScope: "ASSET", searchText: "orders" });
const names = result.items?.map((i) => i.assetItem?.name);
```

@binding

## SearchListings

Runtime binding for `datazone:SearchListings`.

Searches published listings (the catalog of subscribable assets and data products) in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.SearchListingsHttp)`.
### Searching the Catalog
**Example:** Find Subscribable Listings
```typescript
// init — bind the operation to the domain
const searchListings = yield* AWS.DataZone.SearchListings(domain);

// runtime
const result = yield* searchListings({ searchText: "customer" });
const listings = result.items?.map((i) => i.assetListing?.name);
```

@binding

## SearchTypes

Runtime binding for `datazone:SearchTypes`.

Searches asset types and form types registered in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.SearchTypesHttp)`.
### Searching the Catalog
**Example:** List Managed Asset Types
```typescript
// init — bind the operation to the domain
const searchTypes = yield* AWS.DataZone.SearchTypes(domain);

// runtime
const result = yield* searchTypes({ searchScope: "ASSET_TYPE", managed: true });
```

@binding

## StartDataSourceRun

Runtime binding for `datazone:StartDataSourceRun`.

Triggers an on-demand run of a data source in the bound domain, ingesting new technical assets into the inventory. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.StartDataSourceRunHttp)`.
### Data Source Runs
**Example:** Trigger an Ingestion Run
```typescript
// init — bind the operation to the domain
const startDataSourceRun = yield* AWS.DataZone.StartDataSourceRun(domain);

// runtime
const run = yield* startDataSourceRun({ dataSourceIdentifier: dataSourceId });
```

@binding

## StartMetadataGenerationRun

Runtime binding for `datazone:StartMetadataGenerationRun`.

Starts an ML metadata generation run (business description suggestions) for an asset in the bound domain. The domain id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DataZone.StartMetadataGenerationRunHttp)`.
### Metadata Generation
**Example:** Generate Business Descriptions
```typescript
// init — bind the operation to the domain
const startMetadataGenerationRun = yield* AWS.DataZone.StartMetadataGenerationRun(domain);

// runtime
const run = yield* startMetadataGenerationRun({
  types: ["BUSINESS_DESCRIPTIONS"],
  target: { type: "ASSET", identifier: assetId },
  owningProjectIdentifier: projectId,
});
```

@binding
