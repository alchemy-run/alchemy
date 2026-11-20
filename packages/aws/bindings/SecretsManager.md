<!-- Docs for the generated AWS.SecretsManager bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeSecret

Runtime binding for `secretsmanager:DescribeSecret`.

Bind this operation to a `Secret` to get a callable that reads the secret's
metadata (name, description, rotation config, version stages) without
exposing its value. Provide the implementation with
`Effect.provide(AWS.SecretsManager.DescribeSecretHttp)`.
### Inspecting Secrets
**Example:** Read a Secret's Metadata
```typescript
// init — bind the operation to the secret
const describeSecret = yield* AWS.SecretsManager.DescribeSecret(secret);

// runtime — metadata only, no secret value in the response
const info = yield* describeSecret();
const arn = info.ARN;
const description = info.Description;
```

@binding

## GetRandomPassword

Runtime binding for `secretsmanager:GetRandomPassword`.

Account-level operation (no target secret): bind it with no arguments to
get a callable that generates cryptographically strong random passwords —
typically paired with `PutSecretValue` for rotation. Provide the
implementation with
`Effect.provide(AWS.SecretsManager.GetRandomPasswordHttp)`.
### Generating Passwords
**Example:** Generate and Store a New Password
```typescript
// init — account-level, no resource argument
const getRandomPassword = yield* AWS.SecretsManager.GetRandomPassword();
const putSecretValue = yield* AWS.SecretsManager.PutSecretValue(secret);

// runtime — generate, then rotate the secret to it
const generated = yield* getRandomPassword({
  PasswordLength: 32,
  ExcludePunctuation: true,
});
yield* putSecretValue({ SecretString: generated.RandomPassword });
```

@binding

## GetSecretValue

Runtime binding for `secretsmanager:GetSecretValue`.

Bind this operation to a `Secret` in the function's init phase to get a
callable that reads the current (or a specific) secret version — the secret
ARN is injected automatically and `secretsmanager:GetSecretValue` is
granted on the secret. Provide the implementation with
`Effect.provide(AWS.SecretsManager.GetSecretValueHttp)`.

Secret values are sensitive: `SecretString` / `SecretBinary` may be handed
back wrapped in `Redacted` — unwrap with `Redacted.value` before use.

AWS lists `secretsmanager:GetSecretValue` as the required permission for
retrieving the value; `DescribeSecret` is metadata-only and is not needed.
If the secret uses a customer-managed KMS key, the caller additionally
needs `kms:Decrypt` for that key. See the [GetSecretValue API](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html)
and [Secrets Manager authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html).
### Reading Secret Values
**Example:** Read the Current Secret Value
```typescript
// init — bind the operation to the secret
const secret = yield* AWS.SecretsManager.Secret("DbPassword", {
  secretString: Redacted.make("initial-password"),
});
const getSecretValue = yield* AWS.SecretsManager.GetSecretValue(secret);

// runtime — reads the AWSCURRENT version
const result = yield* getSecretValue();
const value =
  typeof result.SecretString === "string"
    ? result.SecretString
    : Redacted.value(result.SecretString!);
```

@see https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
@see https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html

@binding

## ListSecretVersionIds

Runtime binding for `secretsmanager:ListSecretVersionIds`.

Bind this operation to a `Secret` to get a callable that lists the
secret's version IDs and their staging labels (`AWSCURRENT`,
`AWSPENDING`, `AWSPREVIOUS`) — useful for rotation functions and audit
tooling. Provide the implementation with
`Effect.provide(AWS.SecretsManager.ListSecretVersionIdsHttp)`.
### Inspecting Secrets
**Example:** List a Secret's Versions
```typescript
// init — bind the operation to the secret
const listVersions = yield* AWS.SecretsManager.ListSecretVersionIds(secret);

// runtime — every version with its staging labels
const result = yield* listVersions({ IncludeDeprecated: true });
const current = (result.Versions ?? []).find((version) =>
  version.VersionStages?.includes("AWSCURRENT"),
);
```

@binding

## ListSecrets

Runtime binding for `secretsmanager:ListSecrets`.

Account-level operation (no target secret): bind it with no arguments to
get a callable that lists the account's secrets (metadata only, never
values). Provide the implementation with
`Effect.provide(AWS.SecretsManager.ListSecretsHttp)`.
### Listing Secrets
**Example:** List Secrets by Name
```typescript
// init — account-level, no resource argument
const listSecrets = yield* AWS.SecretsManager.ListSecrets();

// runtime — filter server-side by name
const result = yield* listSecrets({
  Filters: [{ Key: "name", Values: ["my-app/"] }],
});
const names = (result.SecretList ?? []).map((entry) => entry.Name);
```

@binding

## PutSecretValue

Runtime binding for `secretsmanager:PutSecretValue`.

Bind this operation to a `Secret` to get a callable that writes a new
secret version (string or binary); the new version becomes `AWSCURRENT`.
Provide the implementation with
`Effect.provide(AWS.SecretsManager.PutSecretValueHttp)`.
### Writing Secret Values
**Example:** Rotate a Secret's Value
```typescript
// init — bind the operation to the secret
const putSecretValue = yield* AWS.SecretsManager.PutSecretValue(secret);

// runtime — write a new version; the response carries its VersionId
const result = yield* putSecretValue({
  SecretString: newPassword,
});
```

**Example:** Store a Binary Payload
```typescript
yield* putSecretValue({
  SecretBinary: new TextEncoder().encode(JSON.stringify(credentials)),
});
```

@binding

## RotateSecret

Runtime binding for `secretsmanager:RotateSecret`.

Bind this operation to a `Secret` to get a callable that triggers an
immediate rotation using the secret's configured rotation function (see
{@link onSecretRotation} for wiring one up). Provide the implementation
with `Effect.provide(AWS.SecretsManager.RotateSecretHttp)`.
### Rotating Secrets
**Example:** Trigger an On-Demand Rotation
```typescript
// init — bind the operation to the secret
const rotateSecret = yield* AWS.SecretsManager.RotateSecret(secret);

// runtime — kicks off the configured rotation function
const result = yield* rotateSecret();
const pendingVersionId = result.VersionId;
```

@binding

## UpdateSecretVersionStage

Runtime binding for `secretsmanager:UpdateSecretVersionStage`.

Bind this operation to a `Secret` to get a callable that moves a staging
label between versions — the final `finishSecret` step of the rotation
protocol, where `AWSCURRENT` is moved onto the new version. Provide the
implementation with
`Effect.provide(AWS.SecretsManager.UpdateSecretVersionStageHttp)`.
### Rotating Secrets
**Example:** Promote a Pending Version to AWSCURRENT
```typescript
// init — bind the operation to the secret
const updateStage = yield* AWS.SecretsManager.UpdateSecretVersionStage(secret);

// runtime — finishSecret: move AWSCURRENT onto the pending version
yield* updateStage({
  VersionStage: "AWSCURRENT",
  MoveToVersionId: pendingVersionId,
  RemoveFromVersionId: currentVersionId,
});
```

@binding
