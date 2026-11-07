<!-- Docs for the generated AWS.Route53Profiles bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ListProfileAssociations

Runtime binding for `route53profiles:ListProfileAssociations` — enumerate
the VPC associations of the bound {@link Profile} (each item carries the
association id, VPC `ResourceId`, and its `Status`), so an ops function
can audit which VPCs a shared DNS configuration currently applies to or
wait for an association to reach `COMPLETE`. The profile's id is injected
automatically.

Provide `AWS.Route53Profiles.ListProfileAssociationsHttp` on the hosting
Lambda Function to satisfy the requirement.
### Listing VPC Associations
**Example:** Enumerate the VPCs a Profile applies to
```typescript
// init — grants route53profiles:ListProfileAssociations
const listProfileAssociations =
  yield* AWS.Route53Profiles.ListProfileAssociations(profile);

// runtime
const { ProfileAssociations = [] } = yield* listProfileAssociations();
for (const association of ProfileAssociations) {
  yield* Effect.log(`${association.ResourceId}: ${association.Status}`);
}
```

@binding

## ListProfileAssociations.Request

Request for {@link ListProfileAssociations} — the bound profile's id is
injected as `ProfileId`, so only the optional VPC filter and pagination
knobs remain.

## ListProfileResourceAssociations

Runtime binding for `route53profiles:ListProfileResourceAssociations` —
enumerate the DNS resources attached to the bound {@link Profile}
(private hosted zones, Resolver rules, DNS Firewall rule groups; each item
carries the resource's ARN, type, properties, and `Status`), so an ops
function can audit what DNS configuration a shared profile bundles. The
profile's id is injected automatically.

Provide `AWS.Route53Profiles.ListProfileResourceAssociationsHttp` on the
hosting Lambda Function to satisfy the requirement.
### Listing Attached DNS Resources
**Example:** Enumerate the DNS resources attached to a Profile
```typescript
// init — grants route53profiles:ListProfileResourceAssociations
const listProfileResourceAssociations =
  yield* AWS.Route53Profiles.ListProfileResourceAssociations(profile);

// runtime
const { ProfileResourceAssociations = [] } =
  yield* listProfileResourceAssociations();
for (const association of ProfileResourceAssociations) {
  yield* Effect.log(`${association.ResourceType}: ${association.ResourceArn}`);
}
```

@binding

## ListProfileResourceAssociations.Request

Request for {@link ListProfileResourceAssociations} — the bound profile's
id is injected as `ProfileId`, so only the optional `ResourceType` filter
and pagination knobs remain.
