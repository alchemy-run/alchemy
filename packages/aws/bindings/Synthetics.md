<!-- Docs for the generated AWS.Synthetics bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeCanariesLastRun

Runtime binding for `synthetics:DescribeCanariesLastRun` — read the most
recent run of every canary in the account (optionally filtered by
`Names`), e.g. to render a fleet-wide status page.

Provide `Synthetics.DescribeCanariesLastRunHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Canary Status
**Example:** Fleet-Wide Last-Run Summary
```typescript
// init — grants synthetics:DescribeCanariesLastRun
const describeCanariesLastRun =
  yield* AWS.Synthetics.DescribeCanariesLastRun();

// runtime
const { CanariesLastRun } = yield* describeCanariesLastRun();
const failing = CanariesLastRun?.filter(
  (c) => c.LastRun?.Status?.State === "FAILED",
);
```

@binding

## GetCanary

Runtime binding for `synthetics:GetCanary` — read the full configuration
and current status (state, last run, timeline) of the bound
{@link Canary}; the canary name is injected automatically.

Provide `Synthetics.GetCanaryHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading Canary Status
**Example:** Read the Canary's Current State
```typescript
// init — grants synthetics:GetCanary on the canary
const getCanary = yield* AWS.Synthetics.GetCanary(canary);

// runtime
const { Canary } = yield* getCanary();
const state = Canary?.Status?.State;
```

@binding

## GetCanaryRuns

Runtime binding for `synthetics:GetCanaryRuns` — list the run results
(status, timeline, artifact location) of the bound {@link Canary}; the
canary name is injected automatically.

Provide `Synthetics.GetCanaryRunsHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading Canary Runs
**Example:** List Recent Runs
```typescript
// init — grants synthetics:GetCanaryRuns on the canary
const getCanaryRuns = yield* AWS.Synthetics.GetCanaryRuns(canary);

// runtime
const { CanaryRuns } = yield* getCanaryRuns({ MaxResults: 10 });
const failed = CanaryRuns?.filter((run) => run.Status?.State === "FAILED");
```

@binding

## StartCanary

Runtime binding for `synthetics:StartCanary` — start the bound
{@link Canary} running on its configured schedule (e.g. trigger an
on-demand smoke test after a deployment); the canary name is injected
automatically.

Provide `Synthetics.StartCanaryHttp` on the hosting Lambda Function to
satisfy the requirement.
### Controlling the Canary
**Example:** Start the Canary
```typescript
// init — grants synthetics:StartCanary on the canary
const startCanary = yield* AWS.Synthetics.StartCanary(canary);

// runtime — a ConflictException means it is already starting/running
yield* startCanary().pipe(
  Effect.catchTag("ConflictException", () => Effect.void),
);
```

@binding

## StopCanary

Runtime binding for `synthetics:StopCanary` — stop future runs of the
bound {@link Canary} (an in-flight run completes on its own); the canary
name is injected automatically.

Provide `Synthetics.StopCanaryHttp` on the hosting Lambda Function to
satisfy the requirement.
### Controlling the Canary
**Example:** Stop the Canary
```typescript
// init — grants synthetics:StopCanary on the canary
const stopCanary = yield* AWS.Synthetics.StopCanary(canary);

// runtime — a ConflictException means it is not currently running
yield* stopCanary().pipe(
  Effect.catchTag("ConflictException", () => Effect.void),
);
```

@binding
