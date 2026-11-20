<!-- Docs for the generated AWS.ELBv2 bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DeregisterTargets

Runtime binding for the `DeregisterTargets` operation (IAM action
`elasticloadbalancing:DeregisterTargets` scoped to the target-group ARN).

Deregisters targets from the bound target group at runtime — the target
enters `draining` and is removed once in-flight requests complete. Pairs
with {@link RegisterTargets} for custom blue/green orchestration or
graceful self-removal on shutdown.
Provide the implementation with
`Effect.provide(AWS.ELBv2.DeregisterTargetsHttp)`.
### Dynamic Target Management
**Example:** Drain an IP target
```typescript
// init — bind the operation to the target group
const deregisterTargets = yield* AWS.ELBv2.DeregisterTargets(targetGroup);

// runtime — start draining the target
yield* deregisterTargets({
  Targets: [{ Id: "10.0.1.15", Port: 8080 }],
});
```

@binding

## DeregisterTargets.Request

`DeregisterTargets` request with `TargetGroupArn` injected from the bound
{@link TargetGroup}.

## DescribeCapacityReservation

Runtime binding for the `DescribeCapacityReservation` operation (IAM
action `elasticloadbalancing:DescribeCapacityReservation`; ELBv2
`Describe*` actions do not support resource-level permissions, so the
grant is on `*`).

Reads the bound load balancer's LCU capacity reservation status — pairs
with {@link ModifyCapacityReservation} to confirm a reservation is
`provisioned` before a known traffic spike. Provide the implementation
with `Effect.provide(AWS.ELBv2.DescribeCapacityReservationHttp)`.
### Capacity Reservation
**Example:** Read the current reservation
```typescript
// init — bind the operation to the load balancer
const describeCapacityReservation =
  yield* AWS.ELBv2.DescribeCapacityReservation(loadBalancer);

// runtime — read reservation state per Availability Zone
const reservation = yield* describeCapacityReservation();
const states = reservation.CapacityReservationState?.map((s) => s.State);
```

@binding

## DescribeCapacityReservation.Request

`DescribeCapacityReservation` request with `LoadBalancerArn` injected from
the bound {@link LoadBalancer}.

## DescribeTargetHealth

Runtime binding for the `DescribeTargetHealth` operation (IAM action
`elasticloadbalancing:DescribeTargetHealth`; ELBv2 `Describe*` actions do
not support resource-level permissions, so the grant is on `*`).

Reads the live health state of the bound target group's targets — e.g. a
readiness gate that waits for a freshly registered target to turn
`healthy` before shifting traffic, or an ops endpoint surfacing fleet
health. Provide the implementation with
`Effect.provide(AWS.ELBv2.DescribeTargetHealthHttp)`.
### Target Health
**Example:** Check the health of every target
```typescript
// init — bind the operation to the target group
const describeTargetHealth = yield* AWS.ELBv2.DescribeTargetHealth(targetGroup);

// runtime — read health states
const health = yield* describeTargetHealth({});
const states = health.TargetHealthDescriptions?.map(
  (d) => d.TargetHealth?.State,
);
```

@binding

## DescribeTargetHealth.Request

`DescribeTargetHealth` request with `TargetGroupArn` injected from the
bound {@link TargetGroup}.

## GetTrustStoreCaCertificatesBundle

Runtime binding for the `GetTrustStoreCaCertificatesBundle` operation (IAM
action `elasticloadbalancing:GetTrustStoreCaCertificatesBundle` scoped to
the trust-store ARN).

Returns a pre-signed S3 URI (active for ten minutes) for the bound
{@link TrustStore}'s CA certificate bundle — e.g. an ops endpoint that
serves or audits the mTLS CA bundle currently in force. The trust-store
ARN is injected from the binding. Provide the implementation with
`Effect.provide(AWS.ELBv2.GetTrustStoreCaCertificatesBundleHttp)`.
### Trust Store Content
**Example:** Fetch the presigned CA-bundle location
```typescript
// init — bind the operation to the trust store
const getCaBundle = yield* AWS.ELBv2.GetTrustStoreCaCertificatesBundle(trustStore);

// runtime — Location is a presigned S3 URL valid for ten minutes
const { Location } = yield* getCaBundle();
```

@binding

## GetTrustStoreRevocationContent

Runtime binding for the `GetTrustStoreRevocationContent` operation (IAM
action `elasticloadbalancing:GetTrustStoreRevocationContent` scoped to the
trust-store ARN).

Returns a pre-signed S3 URI (active for ten minutes) for a certificate
revocation list (CRL) previously added to the bound {@link TrustStore} —
e.g. an ops endpoint auditing which client certificates are currently
revoked. A missing revocation id surfaces as the typed
`RevocationIdNotFoundException`. Provide the implementation with
`Effect.provide(AWS.ELBv2.GetTrustStoreRevocationContentHttp)`.
### Trust Store Content
**Example:** Fetch a revocation list's presigned location
```typescript
// init — bind the operation to the trust store
const getRevocation = yield* AWS.ELBv2.GetTrustStoreRevocationContent(trustStore);

// runtime
const { Location } = yield* getRevocation({ RevocationId: 1 });
```

@binding

## GetTrustStoreRevocationContent.Request

`GetTrustStoreRevocationContent` request with `TrustStoreArn` injected from
the bound {@link TrustStore}.

## ModifyCapacityReservation

Runtime binding for the `ModifyCapacityReservation` operation (IAM action
`elasticloadbalancing:ModifyCapacityReservation` scoped to the
load-balancer ARN).

Sets or resets the bound load balancer's minimum LCU capacity reservation
at runtime — e.g. a Lambda that pre-provisions capacity ahead of a known
traffic spike (product launch, ticket sale) and resets it afterwards, the
ELBv2 analogue of Auto Scaling's `SetDesiredCapacity`. Provide the
implementation with
`Effect.provide(AWS.ELBv2.ModifyCapacityReservationHttp)`.
### Capacity Reservation
**Example:** Reserve capacity ahead of a spike
```typescript
// init — bind the operation to the load balancer
const modifyCapacityReservation =
  yield* AWS.ELBv2.ModifyCapacityReservation(loadBalancer);

// runtime — reserve 100 LCUs per Availability Zone
yield* modifyCapacityReservation({
  MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
});

// later — release the reservation
yield* modifyCapacityReservation({ ResetCapacityReservation: true });
```

@binding

## ModifyCapacityReservation.Request

`ModifyCapacityReservation` request with `LoadBalancerArn` injected from
the bound {@link LoadBalancer}.

## RegisterTargets

Runtime binding for the `RegisterTargets` operation (IAM action
`elasticloadbalancing:RegisterTargets` scoped to the target-group ARN).

Registers targets (instances, IPs, Lambda functions, or an ALB) with the
bound target group at runtime — e.g. custom blue/green orchestration, or
compute that registers itself into a target group at boot.
Provide the implementation with
`Effect.provide(AWS.ELBv2.RegisterTargetsHttp)`.
### Dynamic Target Management
**Example:** Register an IP target
```typescript
// init — bind the operation to the target group
const registerTargets = yield* AWS.ELBv2.RegisterTargets(targetGroup);

// runtime — register a target by IP and port
yield* registerTargets({
  Targets: [{ Id: "10.0.1.15", Port: 8080 }],
});
```

@binding

## RegisterTargets.Request

`RegisterTargets` request with `TargetGroupArn` injected from the bound
{@link TargetGroup}.
