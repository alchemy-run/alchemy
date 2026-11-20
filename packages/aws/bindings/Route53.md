<!-- Docs for the generated AWS.Route53 bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ChangeResourceRecordSets

Runtime binding for the `ChangeResourceRecordSets` operation (IAM action
`route53:ChangeResourceRecordSets` on the hosted zone ARN).

Creates, upserts, and deletes DNS record sets in the bound
{@link HostedZone} at runtime — the core dynamic-DNS primitive (ACME
`dns-01` challenges, service discovery, failover flips). Pair with
{@link GetChange} to wait until the change is `INSYNC`. Provide the
implementation with
`Effect.provide(AWS.Route53.ChangeResourceRecordSetsHttp)`.
### Managing Records at Runtime
**Example:** Upsert a TXT record
```typescript
const changeRecordSets = yield* AWS.Route53.ChangeResourceRecordSets(zone);

const { ChangeInfo } = yield* changeRecordSets({
  ChangeBatch: {
    Changes: [{
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: "_acme-challenge.example.com.",
        Type: "TXT",
        TTL: 60,
        ResourceRecords: [{ Value: '"token"' }],
      },
    }],
  },
});
```

@binding

## ChangeResourceRecordSets.Request

`ChangeResourceRecordSets` request with `HostedZoneId` injected from the
bound {@link HostedZone}.

## GetChange

Runtime binding for the `GetChange` operation (IAM action
`route53:GetChange` on `arn:aws:route53:::change/*`).

Polls the status of a record change submitted via
{@link ChangeResourceRecordSets} — `PENDING` until the change has
propagated to all authoritative name servers, then `INSYNC`. Pass the
bare change id (strip a leading `/change/` from `ChangeInfo.Id`).
Provide the implementation with
`Effect.provide(AWS.Route53.GetChangeHttp)`.
### Managing Records at Runtime
**Example:** Wait for a change to propagate
```typescript
const getChange = yield* AWS.Route53.GetChange();

const status = yield* getChange({
  Id: changeId.replace(/^\/change\//, ""),
}).pipe(
  Effect.map((r) => r.ChangeInfo.Status),
  Effect.repeat({
    schedule: Schedule.fixed("2 seconds"),
    until: (status) => status === "INSYNC",
    times: 30,
  }),
);
```

@binding

## GetHealthCheckLastFailureReason

Runtime binding for the `GetHealthCheckLastFailureReason` operation (IAM
action `route53:GetHealthCheckLastFailureReason` on the health check ARN).

Reads the reason each Route 53 checker last reported the bound
{@link HealthCheck} unhealthy — the diagnostic companion to
{@link GetHealthCheckStatus} for alerting and incident tooling. Endpoint
checks only (not `CALCULATED` / `RECOVERY_CONTROL`). Provide the
implementation with
`Effect.provide(AWS.Route53.GetHealthCheckLastFailureReasonHttp)`.
### Observing Health Checks
**Example:** Read the last failure reasons
```typescript
const getLastFailureReason =
  yield* AWS.Route53.GetHealthCheckLastFailureReason(check);

const { HealthCheckObservations } = yield* getLastFailureReason();
```

@binding

## GetHealthCheckStatus

Runtime binding for the `GetHealthCheckStatus` operation (IAM action
`route53:GetHealthCheckStatus` on the health check ARN).

Reads the bound {@link HealthCheck}'s current status as reported by each
Route 53 checker — drive dashboards or failover decisions from the same
signal Route 53 routes on. Endpoint checks only (not `CALCULATED` /
`RECOVERY_CONTROL`). Provide the implementation with
`Effect.provide(AWS.Route53.GetHealthCheckStatusHttp)`.
### Observing Health Checks
**Example:** Read checker observations
```typescript
const getHealthCheckStatus = yield* AWS.Route53.GetHealthCheckStatus(check);

const { HealthCheckObservations } = yield* getHealthCheckStatus();
for (const observation of HealthCheckObservations) {
  yield* Effect.log(
    `${observation.Region}: ${observation.StatusReport?.Status}`,
  );
}
```

@binding

## GetHostedZone

Runtime binding for the `GetHostedZone` operation (IAM action
`route53:GetHostedZone` on the hosted zone ARN).

Reads the bound {@link HostedZone}'s detail — the authoritative name
servers (delegation set), record count, and associated VPCs. Useful for
compute that hands out NS records or verifies delegation at runtime.
Provide the implementation with
`Effect.provide(AWS.Route53.GetHostedZoneHttp)`.
### Inspecting Zones
**Example:** Read the zone's name servers
```typescript
const getHostedZone = yield* AWS.Route53.GetHostedZone(zone);

const { DelegationSet } = yield* getHostedZone();
yield* Effect.log(DelegationSet?.NameServers);
```

@binding

## ListHostedZones

Runtime binding for the `ListHostedZones` operation (IAM action
`route53:ListHostedZones`; list actions do not support resource-level
permissions, so it is granted on `*`).

Pages through the account's hosted zones — zone discovery for multi-tenant
DNS automation that resolves a zone id before editing records. Provide the
implementation with `Effect.provide(AWS.Route53.ListHostedZonesHttp)`.
### Discovering Zones
**Example:** List the account's zones
```typescript
const listHostedZones = yield* AWS.Route53.ListHostedZones();

const { HostedZones } = yield* listHostedZones({ MaxItems: 100 });
```

@binding

## ListHostedZonesByName

Runtime binding for the `ListHostedZonesByName` operation (IAM action
`route53:ListHostedZonesByName`; list actions do not support
resource-level permissions, so it is granted on `*`).

Looks hosted zones up by DNS name in lexicographic order — the direct way
to resolve "which zone owns `example.com`?" at runtime. Provide the
implementation with
`Effect.provide(AWS.Route53.ListHostedZonesByNameHttp)`.
### Discovering Zones
**Example:** Find a zone by name
```typescript
const listByName = yield* AWS.Route53.ListHostedZonesByName();

const { HostedZones } = yield* listByName({
  DNSName: "example.com.",
  MaxItems: 1,
});
```

@binding

## ListHostedZonesByVPC

Runtime binding for the `ListHostedZonesByVPC` operation (IAM actions
`route53:ListHostedZonesByVPC` + `ec2:DescribeVpcs` — Route 53 verifies the
VPC on the caller's behalf; list actions do not support resource-level
permissions, so both are granted on `*`).

Lists the private hosted zones associated with a VPC — discovery for
compute that audits or wires up split-horizon DNS at runtime. Provide the
implementation with `Effect.provide(AWS.Route53.ListHostedZonesByVPCHttp)`.
### Discovering Zones
**Example:** List a VPC's private zones
```typescript
const listByVpc = yield* AWS.Route53.ListHostedZonesByVPC();

const { HostedZoneSummaries } = yield* listByVpc({
  VPCId: "vpc-0123456789abcdef0",
  VPCRegion: "us-east-1",
});
```

@binding

## ListResourceRecordSets

Runtime binding for the `ListResourceRecordSets` operation (IAM action
`route53:ListResourceRecordSets` on the hosted zone ARN).

Pages through the bound {@link HostedZone}'s record sets — read the
current DNS state before computing a change batch, or audit what a
dynamic-DNS workflow has written. Provide the implementation with
`Effect.provide(AWS.Route53.ListResourceRecordSetsHttp)`.
### Managing Records at Runtime
**Example:** List records from a name
```typescript
const listRecordSets = yield* AWS.Route53.ListResourceRecordSets(zone);

const { ResourceRecordSets } = yield* listRecordSets({
  StartRecordName: "www.example.com.",
  MaxItems: 10,
});
```

@binding

## ListResourceRecordSets.Request

`ListResourceRecordSets` request with `HostedZoneId` injected from the
bound {@link HostedZone}.

## TestDNSAnswer

Runtime binding for the `TestDNSAnswer` operation (IAM action
`route53:TestDNSAnswer`; the action does not support resource-level
permissions, so it is granted on `*`).

Asks Route 53's authoritative servers what they would answer for a record
in the bound {@link HostedZone} — works before (and without) delegation,
so it verifies records written via
{@link ChangeResourceRecordSets} without waiting for public DNS. Public
zones only. Provide the implementation with
`Effect.provide(AWS.Route53.TestDNSAnswerHttp)`.
### Inspecting Zones
**Example:** Verify a record answers
```typescript
const testDnsAnswer = yield* AWS.Route53.TestDNSAnswer(zone);

const answer = yield* testDnsAnswer({
  RecordName: "www.example.com",
  RecordType: "A",
});
// answer.ResponseCode -> "NOERROR", answer.RecordData -> the values
```

@binding

## TestDNSAnswer.Request

`TestDNSAnswer` request with `HostedZoneId` injected from the bound
{@link HostedZone}.
