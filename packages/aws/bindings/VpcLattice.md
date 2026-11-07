<!-- Docs for the generated AWS.VpcLattice bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DeregisterTargets

Runtime binding for the `DeregisterTargets` operation (IAM action
`vpc-lattice:DeregisterTargets` on the target group ARN).

Deregisters targets from the bound {@link TargetGroup} at runtime — the
graceful-drain half of dynamic self-registration. Provide the
implementation with `Effect.provide(AWS.VpcLattice.DeregisterTargetsHttp)`.
### Managing Targets at Runtime
**Example:** Deregister a target
```typescript
const deregisterTargets = yield* AWS.VpcLattice.DeregisterTargets(targetGroup);

yield* deregisterTargets({ targets: [{ id: "10.0.1.10", port: 80 }] });
```

@binding

## DeregisterTargets.Request

`DeregisterTargets` request with `targetGroupIdentifier` injected from the
bound {@link TargetGroup}.

## ListTargets

Runtime binding for the `ListTargets` operation (IAM action
`vpc-lattice:ListTargets` on the target group ARN).

Lists the bound {@link TargetGroup}'s registered targets with their health
status — useful for health dashboards and for compute that verifies its own
registration. Provide the implementation with
`Effect.provide(AWS.VpcLattice.ListTargetsHttp)`.
### Managing Targets at Runtime
**Example:** List the target group's targets
```typescript
const listTargets = yield* AWS.VpcLattice.ListTargets(targetGroup);

const { items } = yield* listTargets({});
for (const target of items) {
  yield* Effect.log(`${target.id}: ${target.status}`);
}
```

@binding

## ListTargets.Request

`ListTargets` request with `targetGroupIdentifier` injected from the bound
{@link TargetGroup}.

## RegisterTargets

Runtime binding for the `RegisterTargets` operation (IAM action
`vpc-lattice:RegisterTargets` on the target group ARN).

Registers targets with the bound {@link TargetGroup} at runtime — the
self-registration data plane for workloads that join a lattice service
dynamically. Provide the implementation with
`Effect.provide(AWS.VpcLattice.RegisterTargetsHttp)`.
### Managing Targets at Runtime
**Example:** Register a target
```typescript
const registerTargets = yield* AWS.VpcLattice.RegisterTargets(targetGroup);

const { successful, unsuccessful } = yield* registerTargets({
  targets: [{ id: "10.0.1.10", port: 80 }],
});
```

@binding

## RegisterTargets.Request

`RegisterTargets` request with `targetGroupIdentifier` injected from the
bound {@link TargetGroup}.
