<!-- Docs for the generated AWS.S3Control bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetAccessPoint

Runtime binding for `s3:GetAccessPoint`.

Reads the bound {@link AccessPoint}'s live configuration — bucket,
network origin, public-access-block flags, alias and endpoints — e.g. an
operational dashboard or a controller that verifies the access point is
still wired to the expected bucket. The access point name and owning
account are injected from the binding. Provide the implementation with
`Effect.provide(AWS.S3Control.GetAccessPointHttp)`.
### Observing an Access Point
**Example:** Read the Access Point's Configuration
```typescript
// init — bind the operation to the access point
const getAccessPoint = yield* AWS.S3Control.GetAccessPoint(accessPoint);

// runtime
const live = yield* getAccessPoint();
// live.Bucket, live.NetworkOrigin, live.Endpoints
```

@binding

## GetAccessPointPolicy

Runtime binding for `s3:GetAccessPointPolicy`.

Reads the resource policy attached to the bound {@link AccessPoint}. An
access point without a policy fails with the typed
`NoSuchAccessPointPolicy` tag. Provide the implementation with
`Effect.provide(AWS.S3Control.GetAccessPointPolicyHttp)`.
### Observing an Access Point
**Example:** Read the Access Point's Policy
```typescript
// init — bind the operation to the access point
const getPolicy = yield* AWS.S3Control.GetAccessPointPolicy(accessPoint);

// runtime
const policy = yield* getPolicy().pipe(
  Effect.catchTag("NoSuchAccessPointPolicy", () =>
    Effect.succeed({ Policy: undefined }),
  ),
);
```

@binding

## GetAccessPointPolicyStatus

Runtime binding for `s3:GetAccessPointPolicyStatus`.

Indicates whether the bound {@link AccessPoint}'s policy currently allows
public access — e.g. a compliance auditor Lambda that alerts on publicly
exposed access points. An access point without a policy fails with the
typed `NoSuchAccessPointPolicy` tag. Provide the implementation with
`Effect.provide(AWS.S3Control.GetAccessPointPolicyStatusHttp)`.
### Observing an Access Point
**Example:** Check Whether the Access Point Is Public
```typescript
// init — bind the operation to the access point
const getPolicyStatus =
  yield* AWS.S3Control.GetAccessPointPolicyStatus(accessPoint);

// runtime
const status = yield* getPolicyStatus();
// status.PolicyStatus?.IsPublic === false
```

@binding

## GetMultiRegionAccessPointRoutes

Runtime binding for `s3:GetMultiRegionAccessPointRoutes`.

Reads the bound {@link MultiRegionAccessPoint}'s per-region routing
configuration (each region's `TrafficDialPercentage`) — the observe half
of an active/passive failover controller. Requests are routed to the
`us-west-2` MRAP control plane. Provide the implementation with
`Effect.provide(AWS.S3Control.GetMultiRegionAccessPointRoutesHttp)`.
### Controlling Multi-Region Failover
**Example:** Read the Current Routes
```typescript
// init — bind the operation to the Multi-Region Access Point
const getRoutes =
  yield* AWS.S3Control.GetMultiRegionAccessPointRoutes(mrap);

// runtime
const { Routes } = yield* getRoutes();
// Routes?.map((r) => `${r.Region}: ${r.TrafficDialPercentage}%`)
```

@binding

## ListAccessPoints

Runtime binding for `s3:ListAccessPoints`.

Lists the access points in the caller's account, optionally filtered to a
single bucket — e.g. an inventory Lambda that audits which endpoints
expose a shared dataset. The account id is resolved once via
`sts:GetCallerIdentity`. Provide the implementation with
`Effect.provide(AWS.S3Control.ListAccessPointsHttp)`.
### Listing Access Points
**Example:** List the Access Points on a Bucket
```typescript
// init — account-level binding, no resource argument
const listAccessPoints = yield* AWS.S3Control.ListAccessPoints();

// runtime
const page = yield* listAccessPoints({ Bucket: bucketName });
// page.AccessPointList?.map((ap) => ap.Name)
```

@binding

## SubmitMultiRegionAccessPointRoutes

Runtime binding for `s3:SubmitMultiRegionAccessPointRoutes`.

Shifts traffic between the bound {@link MultiRegionAccessPoint}'s regions
by dialing each region's `TrafficDialPercentage` (0 = passive, 100 =
active) — the act half of an automated failover controller, e.g. a
health-check Lambda that dials a degraded region to 0. Requests are
routed to the `us-west-2` MRAP control plane. Provide the implementation
with `Effect.provide(AWS.S3Control.SubmitMultiRegionAccessPointRoutesHttp)`.
### Controlling Multi-Region Failover
**Example:** Fail Traffic Away from a Region
```typescript
// init — bind the operation to the Multi-Region Access Point
const submitRoutes =
  yield* AWS.S3Control.SubmitMultiRegionAccessPointRoutes(mrap);

// runtime
yield* submitRoutes({
  RouteUpdates: [
    { Region: "us-west-2", TrafficDialPercentage: 0 },
    { Region: "eu-west-1", TrafficDialPercentage: 100 },
  ],
});
```

@binding
