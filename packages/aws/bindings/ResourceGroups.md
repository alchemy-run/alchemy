<!-- Docs for the generated AWS.ResourceGroups bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelTagSyncTask

Runtime binding for `resource-groups:CancelTagSyncTask`.

Cancels a running tag-sync task. Group membership stops being synced to
the tag, but resources already grouped keep their membership. The task
ARN is chosen per request, so the grant is on `*`. Provide the
implementation with `Effect.provide(AWS.ResourceGroups.CancelTagSyncTaskHttp)`.
### Tag-Sync Tasks
**Example:** Cancel A Task
```typescript
// init
const cancelTagSyncTask = yield* AWS.ResourceGroups.CancelTagSyncTask();

// runtime
yield* cancelTagSyncTask({ TaskArn: taskArn });
```

@binding

## GetAccountSettings

Runtime binding for `resource-groups:GetAccountSettings`.

Reads the account's Resource Groups settings — most importantly whether
group lifecycle events (the EventBridge feed consumed by
{@link consumeGroupEvents}) are `ACTIVE`, `INACTIVE`, or stuck in
`ERROR`. Provide the implementation with
`Effect.provide(AWS.ResourceGroups.GetAccountSettingsHttp)`.
### Account Settings
**Example:** Check Group Lifecycle Events Status
```typescript
// init
const getAccountSettings = yield* AWS.ResourceGroups.GetAccountSettings();

// runtime
const { AccountSettings } = yield* getAccountSettings();
const status = AccountSettings?.GroupLifecycleEventsStatus;
```

@binding

## GetTagSyncTask

Runtime binding for `resource-groups:GetTagSyncTask`.

Reads one tag-sync task's detail — the synced tag key/value, the role it
runs as, and its `ACTIVE`/`ERROR` status with the error message. The task
ARN is chosen per request (typically the `TaskArn` returned by
{@link StartTagSyncTask} or found via {@link ListTagSyncTasks}), so the
grant is on `*`. Provide the implementation with
`Effect.provide(AWS.ResourceGroups.GetTagSyncTaskHttp)`.
### Tag-Sync Tasks
**Example:** Read A Task's Status
```typescript
// init
const getTagSyncTask = yield* AWS.ResourceGroups.GetTagSyncTask();

// runtime
const task = yield* getTagSyncTask({ TaskArn: taskArn });
if (task.Status === "ERROR") {
  yield* Effect.logError(`tag sync failed: ${task.ErrorMessage}`);
}
```

@binding

## ListTagSyncTasks

Runtime binding for `resource-groups:ListTagSyncTasks`.

Enumerates the account's tag-sync tasks (optionally filtered to a
specific group) with each task's status — how an ops function audits
which groups are kept in sync with a tag and alerts on tasks in `ERROR`.
Account-level: tasks span groups, so the grant is on `*`. Provide the
implementation with `Effect.provide(AWS.ResourceGroups.ListTagSyncTasksHttp)`.
### Tag-Sync Tasks
**Example:** List A Group's Tag-Sync Tasks
```typescript
// init
const listTagSyncTasks = yield* AWS.ResourceGroups.ListTagSyncTasks();

// runtime
const { TagSyncTasks } = yield* listTagSyncTasks({
  Filters: [{ GroupName: "my-application" }],
});
```

@binding

## SearchResources

Runtime binding for `resource-groups:SearchResources`.

Runs an ad-hoc resource query (the same `TAG_FILTERS_1_0` /
`CLOUDFORMATION_STACK_1_0` syntax a query-based group is defined with)
and returns the matching resource ARNs — a group-less preview of what a
query would capture. Account-level: the query is chosen per request, so
the grant is on `*` (including the Tagging API / CloudFormation
read-through permissions the search fans out to). Provide the
implementation with `Effect.provide(AWS.ResourceGroups.SearchResourcesHttp)`.
### Searching Resources
**Example:** Find Resources By Tag
```typescript
// init
const searchResources = yield* AWS.ResourceGroups.SearchResources();

// runtime
const { ResourceIdentifiers } = yield* searchResources({
  ResourceQuery: {
    Type: "TAG_FILTERS_1_0",
    Query: JSON.stringify({
      ResourceTypeFilters: ["AWS::AllSupported"],
      TagFilters: [{ Key: "env", Values: ["prod"] }],
    }),
  },
});
```

@binding
