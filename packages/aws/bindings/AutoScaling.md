<!-- Docs for the generated AWS.AutoScaling bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeScalingActivities

Runtime binding for the `DescribeScalingActivities` operation (IAM action
`autoscaling:DescribeScalingActivities`; EC2 Auto Scaling `Describe*`
actions do not support resource-level permissions, so the grant is on `*`).

Returns the bound group's recent scaling activities — what scaled, when,
why, and whether it succeeded. Provide the implementation with
`Effect.provide(AWS.AutoScaling.DescribeScalingActivitiesHttp)`.
### Observing Scaling Activity
**Example:** List recent scaling activities
```typescript
// init — bind the operation to the group
const describeScalingActivities =
  yield* AWS.AutoScaling.DescribeScalingActivities(group);

// runtime — page through the group's recent activities
const page = yield* describeScalingActivities({ MaxRecords: 50 });
for (const activity of page.Activities ?? []) {
  yield* Effect.log(`${activity.StatusCode}: ${activity.Cause}`);
}
```

@binding

## DescribeScalingActivities.Request

`DescribeScalingActivities` request with `AutoScalingGroupName` injected
from the bound {@link AutoScalingGroup}.

## ExecutePolicy

Runtime binding for the `ExecutePolicy` operation (IAM action
`autoscaling:ExecutePolicy` scoped to the group ARN).

Executes a step or simple scaling policy on the bound group — useful for
testing a policy's design or driving scaling from application logic.
Target-tracking policies cannot be executed manually. Provide the
implementation with `Effect.provide(AWS.AutoScaling.ExecutePolicyHttp)`.
### Manual Scaling
**Example:** Execute a step scaling policy
```typescript
// init — bind the operation to the group
const executePolicy = yield* AWS.AutoScaling.ExecutePolicy(group);

// runtime — trigger the policy with a synthetic metric breach
yield* executePolicy({
  PolicyName: "scale-out-on-cpu",
  MetricValue: 85,
  BreachThreshold: 80,
});
```

@binding

## ExecutePolicy.Request

`ExecutePolicy` request with `AutoScalingGroupName` injected from the bound
{@link AutoScalingGroup}. `PolicyName` accepts either the policy name or its
ARN (e.g. `policy.policyArn` from a {@link ScalingPolicy}).

## SetDesiredCapacity

Runtime binding for the `SetDesiredCapacity` operation (IAM action
`autoscaling:SetDesiredCapacity` scoped to the group ARN).

Manually sets the size of the bound Auto Scaling Group — e.g. a Lambda that
scales a fleet up ahead of a known traffic spike or down to zero overnight.
Provide the implementation with
`Effect.provide(AWS.AutoScaling.SetDesiredCapacityHttp)`.
### Manual Scaling
**Example:** Scale the fleet to a fixed size
```typescript
// init — bind the operation to the group
const setDesiredCapacity = yield* AWS.AutoScaling.SetDesiredCapacity(group);

// runtime — set the fleet size, honoring the group's cooldown
yield* setDesiredCapacity({ DesiredCapacity: 4, HonorCooldown: true });
```

@binding

## SetDesiredCapacity.Request

`SetDesiredCapacity` request with `AutoScalingGroupName` injected from the
bound {@link AutoScalingGroup}.

## SetInstanceHealth

Runtime binding for the `SetInstanceHealth` operation (IAM action
`autoscaling:SetInstanceHealth` scoped to the group ARN).

Reports an instance's health to EC2 Auto Scaling — the backbone of custom
health checks: a watchdog Lambda (or the instance itself) flags an instance
`Unhealthy` and the group replaces it. Provide the implementation with
`Effect.provide(AWS.AutoScaling.SetInstanceHealthHttp)`.
### Custom Health Checks
**Example:** Flag a failing instance for replacement
```typescript
// init — bind the operation to the group
const setInstanceHealth = yield* AWS.AutoScaling.SetInstanceHealth(group);

// runtime — mark the instance unhealthy so the group replaces it
yield* setInstanceHealth({
  InstanceId: instanceId,
  HealthStatus: "Unhealthy",
});
```

@binding

## SetInstanceHealth.Request

`SetInstanceHealth` request. The operation is instance-scoped — EC2 Auto
Scaling resolves the instance's owning group for authorization, which the
binding grants on the bound {@link AutoScalingGroup}'s ARN.

## SetInstanceProtection

Runtime binding for the `SetInstanceProtection` operation (IAM action
`autoscaling:SetInstanceProtection` scoped to the group ARN).

Toggles scale-in protection on instances — e.g. a worker protects itself
while it processes a long-running job, then removes protection when idle so
the group may reclaim it. Provide the implementation with
`Effect.provide(AWS.AutoScaling.SetInstanceProtectionHttp)`.
### Scale-In Protection
**Example:** Protect a busy worker from scale-in
```typescript
// init — bind the operation to the group
const setInstanceProtection =
  yield* AWS.AutoScaling.SetInstanceProtection(group);

// runtime — protect while working, release when idle
yield* setInstanceProtection({
  InstanceIds: [instanceId],
  ProtectedFromScaleIn: true,
});
```

@binding

## SetInstanceProtection.Request

`SetInstanceProtection` request with `AutoScalingGroupName` injected from
the bound {@link AutoScalingGroup}.

## TerminateInstanceInAutoScalingGroup

Runtime binding for the `TerminateInstanceInAutoScalingGroup` operation
(IAM action `autoscaling:TerminateInstanceInAutoScalingGroup` scoped to the
group ARN).

Requests termination of a specific instance, optionally decrementing the
desired capacity — e.g. recycling a wedged worker (the group launches a
replacement) or retiring the instance it runs on. Provide the
implementation with
`Effect.provide(AWS.AutoScaling.TerminateInstanceInAutoScalingGroupHttp)`.
### Manual Scaling
**Example:** Recycle a wedged instance
```typescript
// init — bind the operation to the group
const terminateInstance =
  yield* AWS.AutoScaling.TerminateInstanceInAutoScalingGroup(group);

// runtime — terminate and let the group launch a replacement
const { Activity } = yield* terminateInstance({
  InstanceId: instanceId,
  ShouldDecrementDesiredCapacity: false,
});
```

@binding

## TerminateInstanceInAutoScalingGroup.Request

`TerminateInstanceInAutoScalingGroup` request. The operation is
instance-scoped — EC2 Auto Scaling resolves the instance's owning group for
authorization, which the binding grants on the bound
{@link AutoScalingGroup}'s ARN.
