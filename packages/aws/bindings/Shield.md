<!-- Docs for the generated AWS.Shield bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeAttack

Runtime binding for `shield:DescribeAttack`.

Hydrates the full detail document of a DDoS attack (vectors, counters,
mitigations, sub-resources) from an attack id surfaced by
{@link ListAttacks}. Requires an active Shield Advanced subscription; a
nonexistent attack id answers with an empty document or the typed
`AccessDeniedException`.
Provide the implementation with
`Effect.provide(AWS.Shield.DescribeAttackHttp)`.
### Attack Visibility
**Example:** Hydrate Attack Details
```typescript
// init — account-level binding, no resource argument
const describeAttack = yield* AWS.Shield.DescribeAttack();

// runtime
const { Attack } = yield* describeAttack({ AttackId: attackId });
```

@binding

## DescribeAttackStatistics

Runtime binding for `shield:DescribeAttackStatistics`.

Returns the number and type of DDoS attacks Shield has detected in the last
year across all of the account's resources — available to Standard and
Advanced customers alike, so it works without a subscription.
Provide the implementation with
`Effect.provide(AWS.Shield.DescribeAttackStatisticsHttp)`.
### Attack Visibility
**Example:** Read the Yearly Attack Statistics
```typescript
// init — account-level binding, no resource argument
const describeAttackStatistics = yield* AWS.Shield.DescribeAttackStatistics();

// runtime
const { TimeRange, DataItems } = yield* describeAttackStatistics();
```

@binding

## DescribeDRTAccess

Runtime binding for `shield:DescribeDRTAccess`.

Returns the IAM role and S3 log buckets the Shield Response Team (SRT) is
currently authorized to use while assisting with attack mitigation —
useful for security-posture audit handlers. Requires an active Shield
Advanced subscription; without one the call fails with the typed
`ResourceNotFoundException`.
Provide the implementation with
`Effect.provide(AWS.Shield.DescribeDRTAccessHttp)`.
### Shield Response Team Access
**Example:** Audit SRT Access
```typescript
// init — account-level binding, no resource argument
const describeDRTAccess = yield* AWS.Shield.DescribeDRTAccess();

// runtime
const { RoleArn, LogBucketList } = yield* describeDRTAccess();
```

@binding

## GetSubscriptionState

Runtime binding for `shield:GetSubscriptionState`.

Returns whether the account's Shield Advanced subscription is `ACTIVE` or
`INACTIVE` — available to every account, subscribed or not, so a handler
can branch on Shield Advanced availability before calling gated operations.
Provide the implementation with
`Effect.provide(AWS.Shield.GetSubscriptionStateHttp)`.
### Subscription Visibility
**Example:** Check Shield Advanced Availability
```typescript
// init — account-level binding, no resource argument
const getSubscriptionState = yield* AWS.Shield.GetSubscriptionState();

// runtime
const { SubscriptionState } = yield* getSubscriptionState();
if (SubscriptionState === "ACTIVE") {
  // Shield Advanced operations are available
}
```

@binding

## ListAttacks

Runtime binding for `shield:ListAttacks`.

Lists all ongoing DDoS attacks, or all attacks in a given time window,
optionally filtered to specific protected-resource ARNs — the entry point
for a security dashboard or attack-alerting handler. Requires an active
Shield Advanced subscription.
Provide the implementation with `Effect.provide(AWS.Shield.ListAttacksHttp)`.
### Attack Visibility
**Example:** List Ongoing Attacks
```typescript
// init — account-level binding, no resource argument
const listAttacks = yield* AWS.Shield.ListAttacks();

// runtime — omitting the time range returns ongoing attacks
const { AttackSummaries } = yield* listAttacks();
```

@binding

## ListResourcesInProtectionGroup

Runtime binding for `shield:ListResourcesInProtectionGroup`.

Enumerates the ARNs of the protected resources that are members of a
protection group. The group id is passed in the request — group membership
is often resolved dynamically at runtime (e.g. iterating the groups from a
`ListProtectionGroups` sweep), and a nonexistent group fails with the typed
`ResourceNotFoundException`.
Provide the implementation with
`Effect.provide(AWS.Shield.ListResourcesInProtectionGroupHttp)`.
### Grouping Protections
**Example:** List a Group's Members
```typescript
// init — account-level binding, no resource argument
const listResourcesInProtectionGroup =
  yield* AWS.Shield.ListResourcesInProtectionGroup();

// runtime
const { ResourceArns } = yield* listResourcesInProtectionGroup({
  ProtectionGroupId: group.protectionGroupId,
});
```

@binding
