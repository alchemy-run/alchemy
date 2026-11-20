<!-- Docs for the generated AWS.GlobalAccelerator bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AddEndpoints

Runtime binding for `globalaccelerator:AddEndpoints`.

Registers additional endpoints (ALB/NLB ARNs, EC2 instance IDs, or Elastic
IP allocation IDs) on the bound {@link EndpointGroup} at runtime — the
dynamic-scaling counterpart to declaring `endpoints` in the resource
props. Unlike a full `UpdateEndpointGroup`, adding endpoints does not
touch the group's other endpoints or its health-check configuration. The
endpoint group ARN is injected from the binding. Provide the
implementation with
`Effect.provide(AWS.GlobalAccelerator.AddEndpointsHttp)`.
### Managing Endpoints
**Example:** Register an Endpoint Dynamically
```typescript
// init — bind the operation to the endpoint group
const addEndpoints = yield* AWS.GlobalAccelerator.AddEndpoints(group);

// runtime
yield* addEndpoints({
  EndpointConfigurations: [{ EndpointId: allocationId, Weight: 128 }],
});
```

@binding

## DescribeAccelerator

Runtime binding for `globalaccelerator:DescribeAccelerator`.

Reads the bound {@link Accelerator}'s live state — deployment status
(`DEPLOYED` / `IN_PROGRESS`), DNS names, static IP sets, and whether it is
enabled — so a function can health-check the accelerator or hand out its
DNS name at runtime. The accelerator ARN is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.GlobalAccelerator.DescribeAcceleratorHttp)`.
### Observing Accelerators
**Example:** Read the Accelerator's Status and DNS Name
```typescript
// init — bind the operation to the accelerator
const describeAccelerator =
  yield* AWS.GlobalAccelerator.DescribeAccelerator(accelerator);

// runtime
const { Accelerator } = yield* describeAccelerator();
yield* Effect.log(`${Accelerator?.DnsName} is ${Accelerator?.Status}`);
```

@binding

## DescribeEndpointGroup

Runtime binding for `globalaccelerator:DescribeEndpointGroup`.

Reads the bound {@link EndpointGroup}'s live state — most usefully the
observed per-endpoint health (`HEALTHY` / `UNHEALTHY` / `INITIAL`) — so a
function can monitor regional endpoint health or verify an endpoint it
just registered. The endpoint group ARN is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.GlobalAccelerator.DescribeEndpointGroupHttp)`.
### Observing Endpoint Groups
**Example:** Check Endpoint Health
```typescript
// init — bind the operation to the endpoint group
const describeEndpointGroup =
  yield* AWS.GlobalAccelerator.DescribeEndpointGroup(group);

// runtime
const { EndpointGroup } = yield* describeEndpointGroup({});
const unhealthy = (EndpointGroup?.EndpointDescriptions ?? []).filter(
  (endpoint) => endpoint.HealthState === "UNHEALTHY",
);
```

@binding

## RemoveEndpoints

Runtime binding for `globalaccelerator:RemoveEndpoints`.

Deregisters endpoints from the bound {@link EndpointGroup} at runtime —
e.g. draining an instance before it is terminated. Unlike a full
`UpdateEndpointGroup`, removing endpoints leaves the group's other
endpoints and health-check configuration untouched. The endpoint group
ARN is injected from the binding. Provide the implementation with
`Effect.provide(AWS.GlobalAccelerator.RemoveEndpointsHttp)`.
### Managing Endpoints
**Example:** Deregister an Endpoint
```typescript
// init — bind the operation to the endpoint group
const removeEndpoints = yield* AWS.GlobalAccelerator.RemoveEndpoints(group);

// runtime
yield* removeEndpoints({
  EndpointIdentifiers: [{ EndpointId: allocationId }],
});
```

@binding
