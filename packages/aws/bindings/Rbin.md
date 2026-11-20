<!-- Docs for the generated AWS.Rbin bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetRule

Runtime binding for `rbin:GetRule`.

Reads the bound retention {@link Rule}'s full detail — retention period,
resource type, resource/exclusion tags, lock state, and status — so a
function can audit its Recycle Bin coverage or alert on an unexpected
unlock at runtime. The rule's identifier is injected from the binding.
Provide the implementation with `Effect.provide(AWS.Rbin.GetRuleHttp)`.
### Reading Retention Rules
**Example:** Check the bound rule's retention period
```typescript
// init — grants rbin:GetRule on the rule's ARN
const getRule = yield* AWS.Rbin.GetRule(rule);

// runtime
const detail = yield* getRule();
yield* Effect.log(
  `rule ${detail.Identifier} retains ${detail.ResourceType} for ` +
    `${detail.RetentionPeriod?.RetentionPeriodValue} days (${detail.LockState ?? "unlocked"})`,
);
```

@binding

## ListRules

Runtime binding for `rbin:ListRules`.

Enumerates the Region's Recycle Bin retention rules for a resource type
(`EBS_SNAPSHOT`, `EC2_IMAGE`, or `EBS_VOLUME`), optionally filtered by
resource tags, exclusion tags, or lock state — so a function can verify
that deletion protection is in place before destructive maintenance.
`ListRules` is an account-level list action, so the grant is on `*`.
Provide the implementation with `Effect.provide(AWS.Rbin.ListRulesHttp)`.
### Listing Retention Rules
**Example:** Enumerate the Region's snapshot retention rules
```typescript
// init — grants rbin:ListRules on *
const listRules = yield* AWS.Rbin.ListRules();

// runtime
const { Rules } = yield* listRules({ ResourceType: "EBS_SNAPSHOT" });
for (const rule of Rules ?? []) {
  yield* Effect.log(`${rule.Identifier}: ${rule.Description ?? ""}`);
}
```

@binding
