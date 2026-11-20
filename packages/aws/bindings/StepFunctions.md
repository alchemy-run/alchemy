<!-- Docs for the generated AWS.StepFunctions bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeExecution

Runtime binding for `states:DescribeExecution`.

Bind this operation to a {@link StateMachine} inside a function runtime to
poll the status and output of that machine's executions. IAM access is
scoped to executions of the bound state machine.
### Polling Executions
**Example:** Check an execution's status
```typescript
const describeExecution = yield* StepFunctions.DescribeExecution(machine);

const execution = yield* describeExecution({ executionArn });
// execution.status: "RUNNING" | "SUCCEEDED" | "FAILED" | ...
```

@binding

## DescribeMapRun

Runtime binding for `states:DescribeMapRun`.

Returns a Distributed Map Run's status, item counts, and configuration.
IAM access is scoped to Map Runs of the bound {@link StateMachine};
obtain `mapRunArn`s from `ListMapRuns`.
### Distributed Map Runs
**Example:** Inspect a Map Run's progress
```typescript
const describeMapRun = yield* StepFunctions.DescribeMapRun(machine);

const mapRun = yield* describeMapRun({ mapRunArn });
// mapRun.status, mapRun.itemCounts.succeeded, ...
```

@binding

## GetActivityTask

Runtime binding for `states:GetActivityTask` — the activity worker's
long-poll. Bind this operation to an {@link Activity} inside a function
runtime to receive scheduled activity tasks with the activity ARN
injected automatically.

The call blocks for up to 60 seconds when no task is scheduled (an empty
`taskToken` means the poll timed out) — size the host's timeout
accordingly. Complete the returned task with `SendTaskSuccess` /
`SendTaskFailure`, keeping it alive with `SendTaskHeartbeat`.
### Activity Workers
**Example:** Poll for a task and complete it
```typescript
const getActivityTask = yield* StepFunctions.GetActivityTask(activity);
const sendTaskSuccess = yield* StepFunctions.SendTaskSuccess(activity);

const task = yield* getActivityTask({ workerName: "worker-1" });
if (task.taskToken) {
  yield* sendTaskSuccess({
    taskToken: task.taskToken,
    output: JSON.stringify({ handled: true }),
  });
}
```

@binding

## GetExecutionHistory

Runtime binding for `states:GetExecutionHistory`.

Bind this operation to a {@link StateMachine} inside a function runtime
to page through an execution's event history (state transitions, task
results, failures). IAM access is scoped to executions of the bound
state machine. Not supported by `EXPRESS` state machines.
### Polling Executions
**Example:** Inspect why an execution failed
```typescript
const getExecutionHistory =
  yield* StepFunctions.GetExecutionHistory(machine);

const { events } = yield* getExecutionHistory({
  executionArn,
  reverseOrder: true,
  maxResults: 10,
});
// events[0].type === "ExecutionFailed" carries the error details
```

@binding

## ListExecutions

Runtime binding for `states:ListExecutions`.

Bind this operation to a {@link StateMachine} inside a function runtime
to list that machine's executions (optionally filtered by status) with
the state machine ARN injected automatically. Not supported by `EXPRESS`
state machines.
### Polling Executions
**Example:** List running executions
```typescript
const listExecutions = yield* StepFunctions.ListExecutions(machine);

const { executions } = yield* listExecutions({ statusFilter: "RUNNING" });
```

@binding

## ListMapRuns

Runtime binding for `states:ListMapRuns`.

Lists the Distributed Map Runs started by an execution of the bound
{@link StateMachine} — use the returned `mapRunArn`s with
`DescribeMapRun` / `UpdateMapRun`. IAM access is scoped to executions of
the bound state machine.
### Distributed Map Runs
**Example:** List an execution's Map Runs
```typescript
const listMapRuns = yield* StepFunctions.ListMapRuns(machine);

const { mapRuns } = yield* listMapRuns({ executionArn });
```

@binding

## RedriveExecution

Runtime binding for `states:RedriveExecution`.

Restarts a failed, aborted, or timed-out `STANDARD` execution from its
failure point, reusing the same input and execution ARN. IAM access is
scoped to executions of the bound {@link StateMachine}. Executions that
are still running (or succeeded) fail with the typed
`ExecutionNotRedrivable` error.
### Redriving Executions
**Example:** Redrive a failed execution
```typescript
const redriveExecution = yield* StepFunctions.RedriveExecution(machine);

yield* redriveExecution({ executionArn }).pipe(
  Effect.catchTag("ExecutionNotRedrivable", () => Effect.void),
);
```

@binding

## StartExecution

Runtime binding for `states:StartExecution`.

Bind this operation to a {@link StateMachine} inside a function runtime to
get a callable that starts asynchronous executions with the state machine
ARN injected automatically.
### Starting Executions
**Example:** Start a workflow execution
```typescript
const startExecution = yield* StepFunctions.StartExecution(machine);

const execution = yield* startExecution({
  input: JSON.stringify({ orderId: "123" }),
});
// execution.executionArn identifies the running workflow
```

**Example:** Idempotent start via execution name
```typescript
const execution = yield* startExecution({
  name: `order-${orderId}`,
  input: JSON.stringify({ orderId }),
});
```

@binding

## StopExecution

Runtime binding for `states:StopExecution`.

Bind this operation to a {@link StateMachine} inside a function runtime to
cancel that machine's running executions. Not supported by `EXPRESS`
workflows.
### Stopping Executions
**Example:** Cancel a running execution
```typescript
const stopExecution = yield* StepFunctions.StopExecution(machine);

yield* stopExecution({
  executionArn,
  error: "OrderCancelled",
  cause: "user requested cancellation",
});
```

@binding

## TestState

Runtime binding for `states:TestState` — execute a *single* ASL state
(Task, Pass, Wait, Choice, Succeed, Fail) without creating a state
machine, optionally with mocked service integrations.

Service-scoped (no resource argument). States that call other services
(e.g. `lambda:invoke`) need a `roleArn` the caller can `iam:PassRole` —
intrinsic states (Pass/Choice/Succeed/Fail) run without one.
### Testing States
**Example:** Test a Pass state's output processing
```typescript
const testState = yield* StepFunctions.TestState();

const result = yield* testState({
  definition: JSON.stringify({
    Type: "Pass",
    QueryLanguage: "JSONata",
    Output: "{% $states.input.value * 2 %}",
    End: true,
  }),
  input: JSON.stringify({ value: 21 }),
});
// result.status === "SUCCEEDED", result.output === "42"
```

@binding

## UpdateMapRun

Runtime binding for `states:UpdateMapRun`.

Adjusts a running Distributed Map Run's `maxConcurrency` and tolerated
failure thresholds in place. IAM access is scoped to Map Runs of the
bound {@link StateMachine}.
### Distributed Map Runs
**Example:** Throttle a running Map Run
```typescript
const updateMapRun = yield* StepFunctions.UpdateMapRun(machine);

yield* updateMapRun({ mapRunArn, maxConcurrency: 10 });
```

@binding

## ValidateStateMachineDefinition

Runtime binding for `states:ValidateStateMachineDefinition` — AWS's
static ASL validator (the Tier-4 check op for the Step Functions DSL).

Service-scoped (no resource argument): validates any definition string
without creating or updating a state machine. `StateMachine`'s reconcile
runs this same check as a pre-flight; bind it in a function runtime to
validate definitions on demand (e.g. compiled `Sfn` programs before a
deployment pipeline applies them).
### Validating Definitions
**Example:** Validate a definition string
```typescript
const validate = yield* StepFunctions.ValidateStateMachineDefinition();

const report = yield* validate({
  definition: JSON.stringify(definition),
  type: "EXPRESS",
  severity: "ERROR",
});
// report.result === "OK" | "FAIL"; report.diagnostics lists findings
```

@binding
