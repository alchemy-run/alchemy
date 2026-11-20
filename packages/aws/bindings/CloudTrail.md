<!-- Docs for the generated AWS.CloudTrail bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelQuery

Runtime binding for `cloudtrail:CancelQuery`.

Cancels a running CloudTrail Lake query. Cancelling a query that already
finished fails with the typed `InactiveQueryException`. Provide the
implementation with `Effect.provide(AWS.CloudTrail.CancelQueryHttp)`.
### Querying CloudTrail Lake
**Example:** Cancel a Running Query
```typescript
// init — bind the operation to the event data store
const cancelQuery = yield* AWS.CloudTrail.CancelQuery(store);

// runtime
const result = yield* cancelQuery({ QueryId: queryId });
console.log(result.QueryStatus); // CANCELLED
```

@binding

## DescribeQuery

Runtime binding for `cloudtrail:DescribeQuery`.

Reads a CloudTrail Lake query's status, statistics, and error message by
`QueryId` — the polling half of the start/poll/results flow. Provide the
implementation with `Effect.provide(AWS.CloudTrail.DescribeQueryHttp)`.
### Querying CloudTrail Lake
**Example:** Poll a Query to Completion
```typescript
// init — bind the operation to the event data store
const describeQuery = yield* AWS.CloudTrail.DescribeQuery(store);

// runtime
const status = yield* describeQuery({ QueryId: queryId });
console.log(status.QueryStatus); // QUEUED | RUNNING | FINISHED | ...
```

@binding

## GenerateQuery

Runtime binding for `cloudtrail:GenerateQuery`.

Generates a CloudTrail Lake SQL statement from a natural-language prompt
against the bound {@link EventDataStore} (the store list is injected from
the binding). Provide the implementation with
`Effect.provide(AWS.CloudTrail.GenerateQueryHttp)`.
### Querying CloudTrail Lake
**Example:** Generate SQL from a Prompt
```typescript
// init — bind the operation to the event data store
const generateQuery = yield* AWS.CloudTrail.GenerateQuery(store);

// runtime
const result = yield* generateQuery({
  Prompt: "What are my top errors in the past month?",
});
console.log(result.QueryStatement);
```

@binding

## GetQueryResults

Runtime binding for `cloudtrail:GetQueryResults`.

Reads one page of a finished CloudTrail Lake query's result rows — use
`NextToken`/`MaxQueryResults` to paginate large results. Provide the
implementation with `Effect.provide(AWS.CloudTrail.GetQueryResultsHttp)`.
### Querying CloudTrail Lake
**Example:** Read Query Results
```typescript
// init — bind the operation to the event data store
const getQueryResults = yield* AWS.CloudTrail.GetQueryResults(store);

// runtime
const page = yield* getQueryResults({ QueryId: queryId });
console.log(page.QueryResultRows?.length);
```

@binding

## ListInsightsData

Runtime binding for `cloudtrail:ListInsightsData`.

An account-level operation (no resource argument) that reads the raw
Insights events recorded for an insight source — empty when Insights has
recorded no anomalies. Rate-limited by AWS to two requests per second,
per account, per Region. Provide the implementation with
`Effect.provide(AWS.CloudTrail.ListInsightsDataHttp)`.
### Reading Insights Events
**Example:** List Insights Events
```typescript
// init — account-level binding takes no resource
const listInsightsData = yield* AWS.CloudTrail.ListInsightsData();

// runtime
const result = yield* listInsightsData({
  InsightSource: "s3.amazonaws.com",
  DataType: "InsightsEvents",
  MaxResults: 10,
});
console.log((result.Events ?? []).map((e) => e.EventName));
```

@binding

## ListInsightsMetricData

Runtime binding for `cloudtrail:ListInsightsMetricData`.

An account-level operation (no resource argument) that reads the Insights
metric time series (API call rate / error rate) for a given event source
and event name — empty when Insights has recorded no anomalies. Provide
the implementation with
`Effect.provide(AWS.CloudTrail.ListInsightsMetricDataHttp)`.
### Reading Insights Metrics
**Example:** Read API Call Rate Metrics
```typescript
// init — account-level binding takes no resource
const listInsightsMetricData =
  yield* AWS.CloudTrail.ListInsightsMetricData();

// runtime
const result = yield* listInsightsMetricData({
  EventSource: "s3.amazonaws.com",
  EventName: "PutObject",
  InsightType: "ApiCallRateInsight",
});
console.log(result.Timestamps?.length, result.Values?.length);
```

@binding

## ListPublicKeys

Runtime binding for `cloudtrail:ListPublicKeys`.

An account-level operation (no resource argument) that returns the public
keys used to sign CloudTrail digest files in the region — the building
block for verifying log-file integrity at runtime. Provide the
implementation with `Effect.provide(AWS.CloudTrail.ListPublicKeysHttp)`.
### Verifying Log Integrity
**Example:** List Digest Public Keys
```typescript
// init — account-level binding takes no resource
const listPublicKeys = yield* AWS.CloudTrail.ListPublicKeys();

// runtime
const result = yield* listPublicKeys();
console.log(result.PublicKeyList?.map((k) => k.Fingerprint));
```

@binding

## ListQueries

Runtime binding for `cloudtrail:ListQueries`.

Lists the CloudTrail Lake queries that ran against the bound
{@link EventDataStore} in the last seven days — the store is injected from
the binding. Provide the implementation with
`Effect.provide(AWS.CloudTrail.ListQueriesHttp)`.
### Querying CloudTrail Lake
**Example:** List Recent Queries
```typescript
// init — bind the operation to the event data store
const listQueries = yield* AWS.CloudTrail.ListQueries(store);

// runtime
const result = yield* listQueries({ MaxResults: 10 });
console.log(result.Queries?.map((q) => q.QueryId));
```

@binding

## LookupEvents

Runtime binding for `cloudtrail:LookupEvents`.

An account-level operation (no resource argument) that searches the last
90 days of management events recorded in the region — the classic "who did
what" audit read, available without any trail or event data store. Provide
the implementation with `Effect.provide(AWS.CloudTrail.LookupEventsHttp)`.
### Reading Event History
**Example:** Look Up Recent Events
```typescript
// init — account-level binding takes no resource
const lookupEvents = yield* AWS.CloudTrail.LookupEvents();

// runtime
const result = yield* lookupEvents({
  LookupAttributes: [
    { AttributeKey: "EventName", AttributeValue: "CreateBucket" },
  ],
  MaxResults: 10,
});
console.log(result.Events?.map((e) => e.EventName));
```

@binding
