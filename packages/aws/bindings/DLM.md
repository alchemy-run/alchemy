<!-- Docs for the generated AWS.DLM bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetLifecyclePolicies

Runtime binding for `dlm:GetLifecyclePolicies`.

Enumerates the account's Data Lifecycle Manager policies (optionally
filtered by state, resource type, or target tags) — the building block of
backup-coverage auditing: list every policy, flag the ones in `ERROR`, or
verify a fleet's tags are actually covered by an `ENABLED` policy.
Provide the implementation with
`Effect.provide(AWS.DLM.GetLifecyclePoliciesHttp)`.
### Monitoring Lifecycle Policies
**Example:** Find Failed Policies
```typescript
// init — account-level binding, no resource argument
const getLifecyclePolicies = yield* AWS.DLM.GetLifecyclePolicies();

// runtime
const { Policies } = yield* getLifecyclePolicies({ State: "ERROR" });
for (const policy of Policies ?? []) {
  yield* Effect.logError(`DLM policy in ERROR: ${policy.PolicyId}`);
}
```

@binding

## GetLifecyclePolicy

Runtime binding for `dlm:GetLifecyclePolicy`.

Reads the bound {@link LifecyclePolicy}'s full detail — state (including
the observed-only `ERROR`), status message, execution role, and the
complete policy document — so an ops function can audit backup coverage
or alert on a policy that stopped running. The policy id is injected from
the binding. Provide the implementation with
`Effect.provide(AWS.DLM.GetLifecyclePolicyHttp)`.
### Monitoring Lifecycle Policies
**Example:** Check A Policy's State
```typescript
// init — bind the operation to the lifecycle policy
const getLifecyclePolicy = yield* AWS.DLM.GetLifecyclePolicy(policy);

// runtime
const { Policy } = yield* getLifecyclePolicy();
if (Policy?.State === "ERROR") {
  yield* Effect.logError(`DLM policy failed: ${Policy.StatusMessage}`);
}
```

@binding
