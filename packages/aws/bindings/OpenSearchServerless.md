<!-- Docs for the generated AWS.OpenSearchServerless bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchGetEffectiveLifecyclePolicy

Runtime binding for the `BatchGetEffectiveLifecyclePolicy` operation (IAM
action `aoss:BatchGetEffectiveLifecyclePolicy`; the action does not support
resource-level scoping, so the grant is on `*`).

Resolves which retention {@link LifecyclePolicy} is in effect for specific
indexes (identified as `index/{collection}/{index}`). Indexes with no
effective policy are reported in `effectiveLifecyclePolicyErrorDetails`.
Provide the implementation with
`Effect.provide(AWS.OpenSearchServerless.BatchGetEffectiveLifecyclePolicyHttp)`.
### Account Settings
**Example:** Resolve an index's effective retention
```typescript
const batchGetEffectiveLifecyclePolicy =
  yield* AWS.OpenSearchServerless.BatchGetEffectiveLifecyclePolicy();

const response = yield* batchGetEffectiveLifecyclePolicy({
  resourceIdentifiers: [
    { type: "retention", resource: "index/logs/app-logs" },
  ],
});
const effective = response.effectiveLifecyclePolicyDetails?.[0];
yield* Effect.log(`retention: ${effective?.retentionPeriod}`);
```

@binding

## CreateIndex

Runtime binding for the `CreateIndex` operation scoped to one collection
(IAM actions `aoss:CreateIndex` + `aoss:APIAccessAll` on the collection ARN).

Creates an index in the bound {@link Collection} from inside a function
runtime — the control-plane path for the multi-tenant pattern where each
tenant gets its own (vector) index. The calling principal must also be
granted `aoss:CreateIndex` on the index pattern by a data
{@link AccessPolicy}. Provide the implementation with
`Effect.provide(AWS.OpenSearchServerless.CreateIndexHttp)`.
### Managing Indexes at Runtime
**Example:** Create a tenant's vector index
```typescript
// init — bind the operation to the collection
const createIndex = yield* AWS.OpenSearchServerless.CreateIndex(collection);

// runtime
yield* createIndex({
  indexName: `tenant-${tenantId}`,
  indexSchema: {
    mappings: {
      properties: {
        embedding: { type: "knn_vector", dimension: 1536 },
      },
    },
  },
});
```

@binding

## DeleteIndex

Runtime binding for the `DeleteIndex` operation scoped to one collection
(IAM actions `aoss:DeleteIndex` + `aoss:APIAccessAll` on the collection ARN).

Deletes an index from the bound {@link Collection} — the teardown half of
the runtime multi-tenant pattern built with {@link CreateIndex}. Deleting
an already-deleted index surfaces the typed `ResourceNotFoundException`.
The calling principal must also be granted `aoss:DeleteIndex` on the index
pattern by a data {@link AccessPolicy}. Provide the implementation with
`Effect.provide(AWS.OpenSearchServerless.DeleteIndexHttp)`.
### Managing Indexes at Runtime
**Example:** Delete a tenant's index
```typescript
const deleteIndex = yield* AWS.OpenSearchServerless.DeleteIndex(collection);

yield* deleteIndex({ indexName: "tenant-42" }).pipe(
  Effect.catchTag("ResourceNotFoundException", () => Effect.void),
);
```

@binding

## GetAccountSettings

Runtime binding for the `GetAccountSettings` operation (IAM action
`aoss:GetAccountSettings`; the action does not support resource-level
scoping, so the grant is on `*`).

Reads the account-level OpenSearch Serverless settings — the OCU capacity
limits that cap the account's spend. Provide the implementation with
`Effect.provide(AWS.OpenSearchServerless.GetAccountSettingsHttp)`.
### Account Settings
**Example:** Read the account's OCU capacity limits
```typescript
const getAccountSettings = yield* AWS.OpenSearchServerless.GetAccountSettings();

const settings = yield* getAccountSettings();
const limits = settings.accountSettingsDetail?.capacityLimits;
yield* Effect.log(`max indexing OCUs: ${limits?.maxIndexingCapacityInOCU}`);
```

@binding

## GetIndex

Runtime binding for the `GetIndex` operation scoped to one collection
(IAM actions `aoss:GetIndex` + `aoss:APIAccessAll` on the collection ARN).

Reads an index's schema definition from the bound {@link Collection}. A
missing index surfaces the typed `ResourceNotFoundException`. The calling
principal must also be granted `aoss:DescribeIndex` on the index pattern by
a data {@link AccessPolicy}. Provide the implementation with
`Effect.provide(AWS.OpenSearchServerless.GetIndexHttp)`.
### Managing Indexes at Runtime
**Example:** Read an index's schema
```typescript
const getIndex = yield* AWS.OpenSearchServerless.GetIndex(collection);

const { indexSchema } = yield* getIndex({ indexName: "tenant-42" });
```

@binding

## GetPoliciesStats

Runtime binding for the `GetPoliciesStats` operation (IAM action
`aoss:GetPoliciesStats`; the action does not support resource-level
scoping, so the grant is on `*`).

Returns counts of the account's access policies, security policies,
security configurations, and lifecycle policies — useful for quota
dashboards (each policy type has an account quota). Provide the
implementation with
`Effect.provide(AWS.OpenSearchServerless.GetPoliciesStatsHttp)`.
### Account Settings
**Example:** Count the account's policies
```typescript
const getPoliciesStats = yield* AWS.OpenSearchServerless.GetPoliciesStats();

const stats = yield* getPoliciesStats();
yield* Effect.log(`total policies: ${stats.TotalPolicyCount}`);
```

@binding

## UpdateAccountSettings

Runtime binding for the `UpdateAccountSettings` operation (IAM action
`aoss:UpdateAccountSettings`; the action does not support resource-level
scoping, so the grant is on `*`).

Updates the account-level OCU capacity limits — the cost-control automation
path (e.g. a budget alarm handler capping search capacity). Provide the
implementation with
`Effect.provide(AWS.OpenSearchServerless.UpdateAccountSettingsHttp)`.
### Account Settings
**Example:** Cap the account's search capacity
```typescript
const updateAccountSettings = yield* AWS.OpenSearchServerless.UpdateAccountSettings();

yield* updateAccountSettings({
  capacityLimits: { maxSearchCapacityInOCU: 4 },
});
```

@binding

## UpdateIndex

Runtime binding for the `UpdateIndex` operation scoped to one collection
(IAM actions `aoss:UpdateIndex` + `aoss:APIAccessAll` on the collection ARN).

Updates an index's schema in the bound {@link Collection} — add new fields
or change field mappings at runtime. The calling principal must also be
granted `aoss:UpdateIndex` on the index pattern by a data
{@link AccessPolicy}. Provide the implementation with
`Effect.provide(AWS.OpenSearchServerless.UpdateIndexHttp)`.
### Managing Indexes at Runtime
**Example:** Add a field to an index
```typescript
const updateIndex = yield* AWS.OpenSearchServerless.UpdateIndex(collection);

yield* updateIndex({
  indexName: "tenant-42",
  indexSchema: {
    mappings: { properties: { title: { type: "text" } } },
  },
});
```

@binding
