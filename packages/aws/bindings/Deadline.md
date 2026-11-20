<!-- Docs for the generated AWS.Deadline bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateJob

Runtime binding for `deadline:CreateJob`.

Submits a render job to the bound {@link Queue} — the data-plane entry
point of Deadline Cloud. The job template is an Open Job Description
(OJD) document (`JSON` or `YAML`). The queue's `farmId`/`queueId` are
injected from the binding. Provide the implementation with
`Effect.provide(AWS.Deadline.CreateJobHttp)`.
### Submitting Jobs
**Example:** Submit A Job From A Template
```typescript
// init — bind the operation to the queue
const createJob = yield* AWS.Deadline.CreateJob(queue);

// runtime
const { jobId } = yield* createJob({
  template: JSON.stringify(jobTemplate),
  templateType: "JSON",
  priority: 50,
});
```

@binding

## GetJob

Runtime binding for `deadline:GetJob`.

Reads a job's detail in the bound {@link Queue} — lifecycle status, task
run status counts, priority, timing. The queue's `farmId`/`queueId` are
injected from the binding. Provide the implementation with
`Effect.provide(AWS.Deadline.GetJobHttp)`.
### Monitoring Jobs
**Example:** Check A Job's Status
```typescript
// init — bind the operation to the queue
const getJob = yield* AWS.Deadline.GetJob(queue);

// runtime
const job = yield* getJob({ jobId });
if (job.taskRunStatus === "FAILED") {
  yield* Effect.logError(job.lifecycleStatusMessage);
}
```

@binding

## GetSession

Runtime binding for `deadline:GetSession`.

Reads a worker session's detail for a job in the bound {@link Queue} —
lifecycle status, host properties, worker log configuration. The queue's
`farmId`/`queueId` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Deadline.GetSessionHttp)`.
### Monitoring Sessions
**Example:** Inspect A Session
```typescript
// init — bind the operation to the queue
const getSession = yield* AWS.Deadline.GetSession(queue);

// runtime
const session = yield* getSession({ jobId, sessionId });
```

@binding

## GetSessionAction

Runtime binding for `deadline:GetSessionAction`.

Reads one session action's detail (status, timing, exit code, progress,
definition) for a job in the bound {@link Queue}. The queue's
`farmId`/`queueId` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Deadline.GetSessionActionHttp)`.
### Monitoring Sessions
**Example:** Inspect A Session Action
```typescript
// init — bind the operation to the queue
const getSessionAction = yield* AWS.Deadline.GetSessionAction(queue);

// runtime
const action = yield* getSessionAction({ jobId, sessionActionId });
if (action.processExitCode !== undefined && action.processExitCode !== 0) {
  yield* Effect.logError(`action failed: ${action.processExitCode}`);
}
```

@binding

## GetSessionsStatisticsAggregation

Runtime binding for `deadline:GetSessionsStatisticsAggregation`.

Fetches the status and results (cost in USD, runtime, per-group stats)
of an aggregation started with
{@link StartSessionsStatisticsAggregation} on the bound {@link Farm}.
The farm's `farmId` is injected from the binding. Provide the
implementation with
`Effect.provide(AWS.Deadline.GetSessionsStatisticsAggregationHttp)`.
### Usage Statistics
**Example:** Poll An Aggregation Until It Completes
```typescript
// init — bind the operation to the farm
const getAggregation =
  yield* AWS.Deadline.GetSessionsStatisticsAggregation(farm);

// runtime
const result = yield* getAggregation({ aggregationId }).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("2 seconds"),
    until: (r) => r.status !== "IN_PROGRESS",
    times: 30,
  }),
);
```

@binding

## GetStep

Runtime binding for `deadline:GetStep`.

Reads a step's detail for a job in the bound {@link Queue} — lifecycle
status, task run status counts, dependency counts, parameter space. The
queue's `farmId`/`queueId` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Deadline.GetStepHttp)`.
### Monitoring Steps
**Example:** Inspect A Step
```typescript
// init — bind the operation to the queue
const getStep = yield* AWS.Deadline.GetStep(queue);

// runtime
const step = yield* getStep({ jobId, stepId });
```

@binding

## GetTask

Runtime binding for `deadline:GetTask`.

Reads a task's detail for a step in the bound {@link Queue} — run status,
parameters, retry count, latest session action. The queue's
`farmId`/`queueId` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Deadline.GetTaskHttp)`.
### Monitoring Tasks
**Example:** Inspect A Task
```typescript
// init — bind the operation to the queue
const getTask = yield* AWS.Deadline.GetTask(queue);

// runtime
const task = yield* getTask({ jobId, stepId, taskId });
```

@binding

## ListJobParameterDefinitions

Runtime binding for `deadline:ListJobParameterDefinitions`.

Lists the parameter definitions a job's Open Job Description template
declares (name, type, default, allowed values) for a job in the bound
{@link Queue} — useful to introspect what a resubmission would accept.
The queue's `farmId`/`queueId` are injected from the binding. Provide the
implementation with
`Effect.provide(AWS.Deadline.ListJobParameterDefinitionsHttp)`.
### Monitoring Jobs
**Example:** Introspect A Job's Parameters
```typescript
// init — bind the operation to the queue
const listJobParameterDefinitions =
  yield* AWS.Deadline.ListJobParameterDefinitions(queue);

// runtime
const { jobParameterDefinitions } =
  yield* listJobParameterDefinitions({ jobId });
```

@binding

## ListJobs

Runtime binding for `deadline:ListJobs`.

Enumerates the jobs in the bound {@link Queue} (paginated). The queue's
`farmId`/`queueId` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Deadline.ListJobsHttp)`.
### Monitoring Jobs
**Example:** List The Queue's Jobs
```typescript
// init — bind the operation to the queue
const listJobs = yield* AWS.Deadline.ListJobs(queue);

// runtime
const { jobs } = yield* listJobs();
```

@binding

## ListSessionActions

Runtime binding for `deadline:ListSessionActions`.

Lists the session actions (environment enter/exit, task runs, attachment
syncs) recorded for a job in the bound {@link Queue}, optionally filtered
by `sessionId` or `taskId`. The queue's `farmId`/`queueId` are injected
from the binding. Provide the implementation with
`Effect.provide(AWS.Deadline.ListSessionActionsHttp)`.
### Monitoring Sessions
**Example:** List A Job's Session Actions
```typescript
// init — bind the operation to the queue
const listSessionActions = yield* AWS.Deadline.ListSessionActions(queue);

// runtime
const { sessionActions } = yield* listSessionActions({ jobId });
```

@binding

## ListSessions

Runtime binding for `deadline:ListSessions`.

Enumerates the worker sessions of a job in the bound {@link Queue}
(paginated). The queue's `farmId`/`queueId` are injected from the
binding. Provide the implementation with
`Effect.provide(AWS.Deadline.ListSessionsHttp)`.
### Monitoring Sessions
**Example:** List A Job's Sessions
```typescript
// init — bind the operation to the queue
const listSessions = yield* AWS.Deadline.ListSessions(queue);

// runtime
const { sessions } = yield* listSessions({ jobId });
```

@binding

## ListSteps

Runtime binding for `deadline:ListSteps`.

Enumerates the steps of a job in the bound {@link Queue} (paginated).
The queue's `farmId`/`queueId` are injected from the binding. Provide
the implementation with `Effect.provide(AWS.Deadline.ListStepsHttp)`.
### Monitoring Steps
**Example:** List A Job's Steps
```typescript
// init — bind the operation to the queue
const listSteps = yield* AWS.Deadline.ListSteps(queue);

// runtime
const { steps } = yield* listSteps({ jobId });
```

@binding

## ListTasks

Runtime binding for `deadline:ListTasks`.

Enumerates the tasks of a step in the bound {@link Queue} (paginated).
The queue's `farmId`/`queueId` are injected from the binding. Provide
the implementation with `Effect.provide(AWS.Deadline.ListTasksHttp)`.
### Monitoring Tasks
**Example:** List A Step's Tasks
```typescript
// init — bind the operation to the queue
const listTasks = yield* AWS.Deadline.ListTasks(queue);

// runtime
const { tasks } = yield* listTasks({ jobId, stepId });
```

@binding

## SearchJobs

Runtime binding for `deadline:SearchJobs`.

Searches the jobs of the bound {@link Queue} with filter and sort
expressions (name, status, user, parameters, dates). The queue's
`farmId`/`queueIds: [queueId]` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Deadline.SearchJobsHttp)`.
### Monitoring Jobs
**Example:** Find Failed Jobs
```typescript
// init — bind the operation to the queue
const searchJobs = yield* AWS.Deadline.SearchJobs(queue);

// runtime
const { jobs } = yield* searchJobs({
  itemOffset: 0,
  filterExpressions: {
    operator: "AND",
    filters: [
      {
        stringFilter: {
          name: "TASK_RUN_STATUS",
          operator: "EQUAL",
          value: "FAILED",
        },
      },
    ],
  },
});
```

@binding

## SearchSteps

Runtime binding for `deadline:SearchSteps`.

Searches the steps of the bound {@link Queue} (optionally narrowed to one
`jobId`) with filter and sort expressions. The queue's
`farmId`/`queueIds: [queueId]` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Deadline.SearchStepsHttp)`.
### Monitoring Steps
**Example:** Find A Job's Failed Steps
```typescript
// init — bind the operation to the queue
const searchSteps = yield* AWS.Deadline.SearchSteps(queue);

// runtime
const { steps } = yield* searchSteps({
  itemOffset: 0,
  jobId,
  filterExpressions: {
    operator: "AND",
    filters: [
      {
        stringFilter: {
          name: "TASK_RUN_STATUS",
          operator: "EQUAL",
          value: "FAILED",
        },
      },
    ],
  },
});
```

@binding

## SearchTasks

Runtime binding for `deadline:SearchTasks`.

Searches the tasks of the bound {@link Queue} (optionally narrowed to one
`jobId`) with filter and sort expressions. The queue's
`farmId`/`queueIds: [queueId]` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Deadline.SearchTasksHttp)`.
### Monitoring Tasks
**Example:** Page Through A Job's Tasks
```typescript
// init — bind the operation to the queue
const searchTasks = yield* AWS.Deadline.SearchTasks(queue);

// runtime
const { tasks, totalResults } = yield* searchTasks({
  itemOffset: 0,
  jobId,
});
```

@binding

## StartSessionsStatisticsAggregation

Runtime binding for `deadline:StartSessionsStatisticsAggregation`.

Starts an asynchronous usage/cost statistics aggregation over the bound
{@link Farm}'s queues or fleets. Poll the returned `aggregationId` with
{@link GetSessionsStatisticsAggregation} for the results. The farm's
`farmId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.Deadline.StartSessionsStatisticsAggregationHttp)`.
### Usage Statistics
**Example:** Aggregate The Last 24 Hours Of Queue Cost
```typescript
// init — bind the operation to the farm
const startAggregation =
  yield* AWS.Deadline.StartSessionsStatisticsAggregation(farm);

// runtime
const { aggregationId } = yield* startAggregation({
  resourceIds: { queueIds: [queueId] },
  startTime: new Date(Date.now() - 24 * 3600 * 1000),
  endTime: new Date(),
  groupBy: ["QUEUE_ID"],
  statistics: ["SUM"],
});
```

@binding

## UpdateJob

Runtime binding for `deadline:UpdateJob`.

Mutates a job in the bound {@link Queue} — reprioritize, cap failures, or
cancel/suspend/requeue it by setting `targetTaskRunStatus`. The queue's
`farmId`/`queueId` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Deadline.UpdateJobHttp)`.
### Managing Jobs
**Example:** Cancel A Job
```typescript
// init — bind the operation to the queue
const updateJob = yield* AWS.Deadline.UpdateJob(queue);

// runtime
yield* updateJob({ jobId, targetTaskRunStatus: "CANCELED" });
```

@binding

## UpdateStep

Runtime binding for `deadline:UpdateStep`.

Retargets every task of a step in the bound {@link Queue} — requeue
(`READY`), cancel (`CANCELED`), suspend (`SUSPENDED`), or force-fail/
succeed the step's tasks in one call. The queue's `farmId`/`queueId` are
injected from the binding. Provide the implementation with
`Effect.provide(AWS.Deadline.UpdateStepHttp)`.
### Managing Steps
**Example:** Requeue A Step's Tasks
```typescript
// init — bind the operation to the queue
const updateStep = yield* AWS.Deadline.UpdateStep(queue);

// runtime
yield* updateStep({ jobId, stepId, targetTaskRunStatus: "READY" });
```

@binding

## UpdateTask

Runtime binding for `deadline:UpdateTask`.

Retargets a single task of a job in the bound {@link Queue} — requeue
(`READY`), cancel (`CANCELED`), suspend (`SUSPENDED`), or force-fail/
succeed it. The queue's `farmId`/`queueId` are injected from the binding.
Provide the implementation with `Effect.provide(AWS.Deadline.UpdateTaskHttp)`.
### Managing Tasks
**Example:** Cancel A Task
```typescript
// init — bind the operation to the queue
const updateTask = yield* AWS.Deadline.UpdateTask(queue);

// runtime
yield* updateTask({ jobId, stepId, taskId, targetRunStatus: "CANCELED" });
```

@binding
