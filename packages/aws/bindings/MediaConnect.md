<!-- Docs for the generated AWS.MediaConnect bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeFlow

Runtime binding for `mediaconnect:DescribeFlow`.

Reads the bound {@link Flow}'s live state — status (`STANDBY`/`ACTIVE`),
source, outputs, and entitlements — e.g. for an operations dashboard or
a scheduler that only starts a flow that is not already running. The
flow ARN is injected from the binding. Provide the implementation with
`Effect.provide(AWS.MediaConnect.DescribeFlowHttp)`.
### Observing Flows
**Example:** Read the Flow's Current Status
```typescript
// init — bind the operation to the flow
const describeFlow = yield* AWS.MediaConnect.DescribeFlow(flow);

// runtime
const { Flow: current } = yield* describeFlow();
const running = current?.Status === "ACTIVE";
```

@binding

## DescribeFlowSourceMetadata

Runtime binding for `mediaconnect:DescribeFlowSourceMetadata`.

Reads the bound {@link Flow}'s ingest transport-stream metadata — the
programs and their video/audio/data streams — plus status messages about
the source. Useful for confidence monitoring of what is actually
arriving at the flow. A flow whose source is not currently receiving
content answers with `Messages` instead of media info. The flow ARN is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.MediaConnect.DescribeFlowSourceMetadataHttp)`.
### Observing Flows
**Example:** Inspect the Incoming Transport Stream
```typescript
// init — bind the operation to the flow
const sourceMetadata = yield* AWS.MediaConnect.DescribeFlowSourceMetadata(flow);

// runtime
const { TransportMediaInfo, Messages } = yield* sourceMetadata();
const programs = TransportMediaInfo?.Programs ?? [];
```

@binding

## DescribeFlowSourceThumbnail

Runtime binding for `mediaconnect:DescribeFlowSourceThumbnail`.

Fetches a thumbnail of the content currently arriving at the bound
{@link Flow}'s source (base64-encoded, refreshed every few seconds) —
the building block for visual confidence monitoring. Thumbnails are
only generated while the flow is running and `sourceMonitoringConfig`
has thumbnails enabled; otherwise the response carries
`ThumbnailMessages` explaining why no image is available. The flow ARN
is injected from the binding. Provide the implementation with
`Effect.provide(AWS.MediaConnect.DescribeFlowSourceThumbnailHttp)`.
### Observing Flows
**Example:** Render a Confidence Thumbnail
```typescript
// init — bind the operation to the flow
const sourceThumbnail = yield* AWS.MediaConnect.DescribeFlowSourceThumbnail(flow);

// runtime
const { ThumbnailDetails } = yield* sourceThumbnail();
const image = ThumbnailDetails?.Thumbnail; // base64-encoded JPEG
```

@binding

## GrantFlowEntitlements

Runtime binding for `mediaconnect:GrantFlowEntitlements`.

Grants entitlements on the bound {@link Flow} so other AWS accounts can
subscribe to its content — e.g. a self-service affiliate portal that
provisions access for a new subscriber account on demand. Granting more
entitlements than the flow allows fails with the typed
`GrantFlowEntitlements420Exception` tag. The flow ARN is injected from
the binding. Provide the implementation with
`Effect.provide(AWS.MediaConnect.GrantFlowEntitlementsHttp)`.
### Managing Entitlements
**Example:** Grant a Subscriber Access to the Flow
```typescript
// init — bind the operation to the flow
const grantEntitlements = yield* AWS.MediaConnect.GrantFlowEntitlements(flow);

// runtime
const { Entitlements } = yield* grantEntitlements({
  Entitlements: [
    { Name: "affiliate-west", Subscribers: ["111122223333"] },
  ],
});
```

@binding

## ListEntitlements

Runtime binding for `mediaconnect:ListEntitlements`.

Enumerates the entitlements that have been granted TO this account
(the subscriber side of content sharing) — e.g. to discover new
entitlement ARNs a distributor has shared so a flow source can be
provisioned from them. One page per call — pass `NextToken` from the
previous response to continue. Account-level: the deploy-time grant is
`mediaconnect:ListEntitlements` on `*`. Provide the implementation with
`Effect.provide(AWS.MediaConnect.ListEntitlementsHttp)`.
### Managing Entitlements
**Example:** Discover Entitlements Granted to This Account
```typescript
// init — bind the account-level operation
const listEntitlements = yield* AWS.MediaConnect.ListEntitlements();

// runtime
const { Entitlements } = yield* listEntitlements();
```

@binding

## ListFlows

Runtime binding for `mediaconnect:ListFlows`.

Enumerates the account's MediaConnect flows (one page per call — pass
`NextToken` from the previous response to continue). Account-level: the
deploy-time grant is `mediaconnect:ListFlows` on `*`. Provide the
implementation with `Effect.provide(AWS.MediaConnect.ListFlowsHttp)`.
### Observing Flows
**Example:** Enumerate the Account's Flows
```typescript
// init — bind the account-level operation
const listFlows = yield* AWS.MediaConnect.ListFlows();

// runtime
const { Flows } = yield* listFlows({ MaxResults: 20 });
const active = (Flows ?? []).filter((f) => f.Status === "ACTIVE");
```

@binding

## RevokeFlowEntitlement

Runtime binding for `mediaconnect:RevokeFlowEntitlement`.

Revokes an entitlement previously granted on the bound {@link Flow} —
the content immediately becomes unavailable to the subscriber and the
associated output is removed from the flow. The flow ARN is injected
from the binding; the entitlement to revoke is passed at runtime.
Because the IAM resource types for this action are the flow AND the
entitlement (a sibling ARN, not derived from the flow ARN), the
deploy-time grant covers the flow ARN plus the entitlement wildcard.
Provide the implementation with
`Effect.provide(AWS.MediaConnect.RevokeFlowEntitlementHttp)`.
### Managing Entitlements
**Example:** Revoke a Subscriber's Access
```typescript
// init — bind the operation to the flow
const revokeEntitlement = yield* AWS.MediaConnect.RevokeFlowEntitlement(flow);

// runtime
yield* revokeEntitlement({ EntitlementArn: entitlementArn });
```

@binding

## StartFlow

Runtime binding for `mediaconnect:StartFlow`.

Starts the bound {@link Flow}, transitioning it from `STANDBY` through
`STARTING` to `ACTIVE`. An ACTIVE flow ingests and egresses media and
bills hourly — pair with {@link StopFlow} to control transport cost
(e.g. a scheduler Lambda that runs the flow only during broadcast
windows). The flow ARN is injected from the binding. Provide the
implementation with `Effect.provide(AWS.MediaConnect.StartFlowHttp)`.
### Controlling Flows
**Example:** Start the Flow for a Broadcast Window
```typescript
// init — bind the operation to the flow
const startFlow = yield* AWS.MediaConnect.StartFlow(flow);

// runtime
const { Status } = yield* startFlow();
```

@binding

## StopFlow

Runtime binding for `mediaconnect:StopFlow`.

Stops the bound {@link Flow}, transitioning it from `ACTIVE` through
`STOPPING` back to `STANDBY` (where it no longer bills for transport).
Stopping a flow that is not running fails with the typed
`BadRequestException` tag. The flow ARN is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.MediaConnect.StopFlowHttp)`.
### Controlling Flows
**Example:** Stop the Flow After the Broadcast
```typescript
// init — bind the operation to the flow
const stopFlow = yield* AWS.MediaConnect.StopFlow(flow);

// runtime — a flow that is already in STANDBY answers with the typed
// BadRequestException tag
yield* stopFlow().pipe(
  Effect.catchTag("BadRequestException", () => Effect.void),
);
```

@binding
