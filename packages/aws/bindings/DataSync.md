<!-- Docs for the generated AWS.DataSync bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelTaskExecution

Runtime binding for `datasync:CancelTaskExecution`.

Stops a queued or in-flight execution of the bound {@link Task} — e.g. a
kill switch when a transfer was started by mistake or is saturating a
link. Address the execution with the ARN returned by
`StartTaskExecution`; access is granted on the bound task's executions.
Provide the implementation with
`Effect.provide(AWS.DataSync.CancelTaskExecutionHttp)`.
### Running Transfers
**Example:** Cancel A Transfer
```typescript
// init — bind the operation to the task
const cancelTaskExecution = yield* AWS.DataSync.CancelTaskExecution(task);

// runtime
yield* cancelTaskExecution({ TaskExecutionArn: executionArn });
```

@binding

## DescribeTask

Runtime binding for `datasync:DescribeTask`.

Reads the bound {@link Task}'s full detail — status, transfer options,
filters, schedule (including `ScheduleDetails` with the last disable
reason), and the ARN of the currently running execution — so an ops
function can monitor the task's health. The task ARN is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.DataSync.DescribeTaskHttp)`.
### Monitoring Tasks
**Example:** Check The Task's Status
```typescript
// init — bind the operation to the task
const describeTask = yield* AWS.DataSync.DescribeTask(task);

// runtime
const detail = yield* describeTask();
yield* Effect.log(`task ${detail.Name} is ${detail.Status}`);
```

@binding

## DescribeTaskExecution

Runtime binding for `datasync:DescribeTaskExecution`.

Reads one execution of the bound {@link Task} — status, bytes/files
transferred, per-phase results — to monitor an ongoing transfer or check
a finished one. Address the execution with the ARN returned by
`StartTaskExecution`; access is granted on the bound task's executions.
Provide the implementation with
`Effect.provide(AWS.DataSync.DescribeTaskExecutionHttp)`.
### Running Transfers
**Example:** Watch A Transfer's Progress
```typescript
// init — bind the operation to the task
const describeTaskExecution = yield* AWS.DataSync.DescribeTaskExecution(task);

// runtime
const execution = yield* describeTaskExecution({
  TaskExecutionArn: executionArn,
});
yield* Effect.log(`${execution.Status}: ${execution.BytesTransferred} bytes`);
```

@binding

## ListTaskExecutions

Runtime binding for `datasync:ListTaskExecutions`.

Enumerates the bound {@link Task}'s executions (most recent first) so an
ops function can audit run history or find the latest run's ARN. The task
ARN is injected from the binding; pass `MaxResults`/`NextToken` to page.
Provide the implementation with
`Effect.provide(AWS.DataSync.ListTaskExecutionsHttp)`.
### Monitoring Tasks
**Example:** List The Task's Runs
```typescript
// init — bind the operation to the task
const listTaskExecutions = yield* AWS.DataSync.ListTaskExecutions(task);

// runtime
const { TaskExecutions } = yield* listTaskExecutions();
for (const execution of TaskExecutions ?? []) {
  yield* Effect.log(`${execution.TaskExecutionArn}: ${execution.Status}`);
}
```

@binding

## StartTaskExecution

Runtime binding for `datasync:StartTaskExecution`.

Starts a run of the bound {@link Task} — the moment data actually moves.
The task ARN is injected from the binding; pass `OverrideOptions`,
`Includes`/`Excludes`, or a `ManifestConfig` to shape the individual run.
Returns the new execution's ARN for use with `DescribeTaskExecution` /
`CancelTaskExecution`. Provide the implementation with
`Effect.provide(AWS.DataSync.StartTaskExecutionHttp)`.
### Running Transfers
**Example:** Kick Off A Transfer
```typescript
// init — bind the operation to the task
const startTaskExecution = yield* AWS.DataSync.StartTaskExecution(task);

// runtime
const { TaskExecutionArn } = yield* startTaskExecution();
yield* Effect.log(`transfer started: ${TaskExecutionArn}`);
```

@binding

## UpdateTaskExecution

Runtime binding for `datasync:UpdateTaskExecution`.

Modifies an in-flight execution of the bound {@link Task}. The only
mutable option is `BytesPerSecond` — throttle (or unthrottle with `-1`) a
running transfer without cancelling it. The execution must be launching,
preparing, transferring, or verifying. Address it with the ARN returned
by `StartTaskExecution`; access is granted on the bound task's
executions. Provide the implementation with
`Effect.provide(AWS.DataSync.UpdateTaskExecutionHttp)`.
### Running Transfers
**Example:** Throttle A Running Transfer
```typescript
// init — bind the operation to the task
const updateTaskExecution = yield* AWS.DataSync.UpdateTaskExecution(task);

// runtime — cap the transfer at 1 MiB/s
yield* updateTaskExecution({
  TaskExecutionArn: executionArn,
  Options: { BytesPerSecond: 1024 * 1024 },
});
```

@binding
