<!-- Docs for the generated AWS.ECS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ContinueServiceDeployment

Runtime binding for `ecs:ContinueServiceDeployment`.

Bind this operation to a `Service` inside a function runtime to get a
callable that resumes a blue/green deployment paused at a lifecycle-hook
stage — the canonical consumer is the deployment lifecycle-hook Lambda
that validates the green revision and then approves (or vetoes) the
traffic shift. The host is granted `ecs:ContinueServiceDeployment` on the
bound service's deployments.
### Service Deployments
**Example:** Approve a Lifecycle-Hook Stage
```typescript
const continueServiceDeployment =
  yield* AWS.ECS.ContinueServiceDeployment(service);

yield* continueServiceDeployment({
  serviceDeploymentArn: deploymentArn,
  hookId,
});
```

@binding

## DescribeContainerInstances

Runtime binding for `ecs:DescribeContainerInstances`.

Bind this operation to a `Cluster` inside a function runtime to get a
callable that describes container instances registered to the bound
cluster — remaining resources, running-task counts, agent status. The
cluster ARN is injected automatically and the host is granted
`ecs:DescribeContainerInstances` on the cluster's container instances.
### Container Instances
**Example:** Inspect Remaining Capacity
```typescript
const describeContainerInstances =
  yield* AWS.ECS.DescribeContainerInstances(cluster);

const response = yield* describeContainerInstances({
  containerInstances: [containerInstanceArn],
});
const remaining = response.containerInstances?.[0]?.remainingResources;
```

@binding

## DescribeServiceDeployments

Runtime binding for `ecs:DescribeServiceDeployments`.

Bind this operation to a `Service` inside a function runtime to get a
callable that describes the bound service's deployments — rollout state,
circuit-breaker status, target service revision. The host is granted
`ecs:DescribeServiceDeployments` on the service's deployments (deployment
ARNs are only known at runtime, e.g. from `ListServiceDeployments`).
### Service Deployments
**Example:** Inspect a Deployment's Rollout State
```typescript
const describeServiceDeployments =
  yield* AWS.ECS.DescribeServiceDeployments(service);

const response = yield* describeServiceDeployments({
  serviceDeploymentArns: [deploymentArn],
});
const status = response.serviceDeployments?.[0]?.status;
```

@binding

## DescribeServiceRevisions

Runtime binding for `ecs:DescribeServiceRevisions`.

Bind this operation to a `Service` inside a function runtime to get a
callable that describes the bound service's revisions — the immutable
task-definition + configuration snapshots that deployments roll between.
The host is granted `ecs:DescribeServiceRevisions` on the service's
revisions (revision ARNs come from deployment describe/list responses).
### Service Deployments
**Example:** Inspect a Target Revision
```typescript
const describeServiceRevisions =
  yield* AWS.ECS.DescribeServiceRevisions(service);

const response = yield* describeServiceRevisions({
  serviceRevisionArns: [revisionArn],
});
const taskDefinition = response.serviceRevisions?.[0]?.taskDefinition;
```

@binding

## DescribeServices

Runtime binding for `ecs:DescribeServices`.

Bind this operation to a `Cluster` inside a function runtime to get a
callable that describes services in the bound cluster. The cluster ARN is
injected automatically and the host is granted `ecs:DescribeServices` on
the cluster's services.
### Describing Services
**Example:** Check a Service's Deployment Status
```typescript
const describeServices = yield* AWS.ECS.DescribeServices(cluster);

const response = yield* describeServices({ services: [serviceName] });
const runningCount = response.services?.[0]?.runningCount;
```

@binding

## DescribeTasks

Runtime binding for `ecs:DescribeTasks`.

Bind this operation to a `Cluster` inside a function runtime to get a
callable that describes tasks in the bound cluster. The cluster ARN is
injected automatically and the host is granted `ecs:DescribeTasks` on the
cluster's tasks.
### Describing Tasks
**Example:** Poll a Task Until It Stops
```typescript
const describeTasks = yield* AWS.ECS.DescribeTasks(cluster);

const response = yield* describeTasks({ tasks: [taskArn] });
const status = response.tasks?.[0]?.lastStatus;
const exitCode = response.tasks?.[0]?.containers?.[0]?.exitCode;
```

@binding

## ExecuteCommand

Runtime binding for `ecs:ExecuteCommand` (ECS Exec).

Bind this operation to a `Cluster` inside a function runtime to get a
callable that starts a command against a running container in the bound
cluster. The cluster ARN is injected automatically and the host is granted
`ecs:ExecuteCommand` on the cluster and its tasks.

The target task must have been launched with `enableExecuteCommand` and the
task role must allow the SSM messages channel. The response's
`session.tokenValue` is a `Redacted` bearer token for the SSM WebSocket
stream (`session.streamUrl`).
### Executing Commands
**Example:** Run a Command in a Container
```typescript
const executeCommand = yield* AWS.ECS.ExecuteCommand(cluster);

const response = yield* executeCommand({
  task: taskArn,
  command: "ls -al /",
  interactive: true,
});
const streamUrl = response.session?.streamUrl;
```

@binding

## GetTaskProtection

Runtime binding for `ecs:GetTaskProtection`.

Bind this operation to a `Cluster` inside a function runtime to get a
callable that reads the scale-in protection status of service-managed tasks
in the bound cluster. The cluster ARN is injected automatically and the
host is granted `ecs:GetTaskProtection` on the cluster's tasks.
### Task Protection
**Example:** Read a Task's Protection Status
```typescript
const getTaskProtection = yield* AWS.ECS.GetTaskProtection(cluster);

const response = yield* getTaskProtection({ tasks: [taskArn] });
const protected_ = response.protectedTasks?.[0]?.protectionEnabled;
```

@binding

## ListContainerInstances

Runtime binding for `ecs:ListContainerInstances`.

Bind this operation to a `Cluster` inside a function runtime to get a
callable that lists container-instance ARNs registered to the bound
cluster (EC2/EXTERNAL launch types). The cluster ARN is injected
automatically and the host is granted `ecs:ListContainerInstances` on the
cluster.
### Container Instances
**Example:** List ACTIVE Container Instances
```typescript
const listContainerInstances = yield* AWS.ECS.ListContainerInstances(cluster);

const response = yield* listContainerInstances({ status: "ACTIVE" });
const instanceArns = response.containerInstanceArns ?? [];
```

@binding

## ListServiceDeployments

Runtime binding for `ecs:ListServiceDeployments`.

Bind this operation to a `Service` inside a function runtime to get a
callable that lists the bound service's deployments (newest first). The
service and cluster ARNs are injected automatically and the host is
granted `ecs:ListServiceDeployments` on the service.
### Service Deployments
**Example:** Find the In-Progress Deployment
```typescript
const listServiceDeployments = yield* AWS.ECS.ListServiceDeployments(service);

const response = yield* listServiceDeployments({
  status: ["IN_PROGRESS"],
});
const deploymentArn = response.serviceDeployments?.[0]?.serviceDeploymentArn;
```

@binding

## ListServices

Runtime binding for `ecs:ListServices`.

Bind this operation to a `Cluster` inside a function runtime to get a
callable that lists service ARNs in the bound cluster. The cluster ARN is
injected automatically and the grant is conditioned on the bound cluster.
### Listing Services
**Example:** List Fargate Services
```typescript
const listServices = yield* AWS.ECS.ListServices(cluster);

const response = yield* listServices({ launchType: "FARGATE" });
const serviceArns = response.serviceArns ?? [];
```

@binding

## ListTasks

Runtime binding for `ecs:ListTasks`.

Bind this operation to a `Cluster` inside a function runtime to get a
callable that lists task ARNs in the bound cluster. The cluster ARN is
injected automatically and the grant is conditioned on the bound cluster.
### Listing Tasks
**Example:** List Stopped Tasks
```typescript
const listTasks = yield* AWS.ECS.ListTasks(cluster);

const response = yield* listTasks({
  desiredStatus: "STOPPED",
});
const taskArns = response.taskArns ?? [];
```

@binding

## StopServiceDeployment

Runtime binding for `ecs:StopServiceDeployment`.

Bind this operation to a `Service` inside a function runtime to get a
callable that stops an in-progress deployment of the bound service —
either abandoning it or rolling back to the last completed revision.
The host is granted `ecs:StopServiceDeployment` on the service's
deployments.
### Service Deployments
**Example:** Roll Back a Bad Deployment
```typescript
const stopServiceDeployment = yield* AWS.ECS.StopServiceDeployment(service);

yield* stopServiceDeployment({
  serviceDeploymentArn: deploymentArn,
  stopType: "ROLLBACK",
});
```

@binding

## StopTask

Runtime binding for `ecs:StopTask`.

Bind this operation to a `Cluster` inside a function runtime to get a
callable that stops a running task in the bound cluster. The cluster ARN is
injected automatically and the host is granted `ecs:StopTask` on the
cluster's tasks.
### Stopping Tasks
**Example:** Stop a Running Task
```typescript
const stopTask = yield* AWS.ECS.StopTask(cluster);

const response = yield* stopTask({
  task: taskArn,
  reason: "drained by worker",
});
```

@binding

## UpdateContainerInstancesState

Runtime binding for `ecs:UpdateContainerInstancesState`.

Bind this operation to a `Cluster` inside a function runtime to get a
callable that transitions container instances between `ACTIVE` and
`DRAINING` — the canonical building block of an Auto Scaling
lifecycle-hook drain function that gracefully migrates tasks off an
instance before it terminates. The cluster ARN is injected automatically
and the host is granted `ecs:UpdateContainerInstancesState` on the
cluster's container instances.
### Container Instances
**Example:** Drain an Instance Before Termination
```typescript
const updateContainerInstancesState =
  yield* AWS.ECS.UpdateContainerInstancesState(cluster);

yield* updateContainerInstancesState({
  containerInstances: [containerInstanceArn],
  status: "DRAINING",
});
```

@binding
