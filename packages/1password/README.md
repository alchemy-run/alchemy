# @alchemy.run/1password

Read 1Password Environments or vault references into an [Alchemy](https://alchemy.run) stack's Effect
Config through the official `@1password/sdk`. Use desktop authorization locally
and `OP_SERVICE_ACCOUNT_TOKEN` in CI.

```sh
pnpm add alchemy @alchemy.run/1password effect
```

```typescript
import * as OnePassword from "@alchemy.run/1password";

const secrets = [
  OnePassword.Secrets(({ stage }) => ({
    environmentId: stage === "prod" ? "production-id" : "development-id",
  })),
];
// Pass secrets to Alchemy.Stack and read values with Config.Redacted.
```

Alternatively, map config keys to vault item fields:

```typescript
OnePassword.Secrets({
  references: {
    DATABASE_URL: "op://Production/Database/url",
    API_KEY: "op://Production/API/credentials/key",
  },
});
```

Choose exactly one of `environmentId` or `references` per entry. The exported
Effect `SecretReference` schema validates `op://vault/item/[section/]field`
syntax before authentication. Duplicate references are resolved once in a
single SDK batch; any failed reference rejects the whole config load.

Locally, run `alchemy profile edit --add 1Password`, or pass `account`
alongside `environmentId`. Use your desktop account's name or UUID. Enable SDK
integration in 1Password's Developer settings.

The provider never writes downloaded values to `process.env` or disk. It fetches
once per layer initialization, preserves empty values, and reports service-account
rate limits without automatic retries. Check `op service-account ratelimit` and
wait for the relevant quota window to reset before trying again.

- [Setup and troubleshooting](https://alchemy.run/environments/1password)
- [Secret providers](https://alchemy.run/environments/secret-providers)

## Development checks

Run offline validation and the real SDK authentication-rejection test from the
repository root:

```sh
pnpm test:integration test/1password
```

Live tests are opt-in and read-only. Create an Environment containing
`ALCHEMY_ONEPASSWORD_TEST=ready`, then set `ONEPASSWORD_TEST_LIVE=1` and
`ONEPASSWORD_TEST_ENVIRONMENT_ID`. For service-account checks, export
`OP_SERVICE_ACCOUNT_TOKEN` and set `ONEPASSWORD_TEST_REFERENCE` to an
`op://vault/item/[section/]field` whose value is `ready`. The service account
must have read access to both fixtures. These checks cover Environment reads,
duplicate references, config precedence, and a partially failing reference batch.
The fixture item must not have a field named `alchemy-audit-missing-field`.

For the desktop check, set `ONEPASSWORD_TEST_DESKTOP_ACCOUNT` and run locally
without `OP_SERVICE_ACCOUNT_TOKEN`. This test prompts for authorization and is
skipped in CI or when a service-account token would take precedence. Tests never
change `CI`. Once live checks are enabled, missing required fixture configuration
fails the run. No test prints secret values or retries errors; service-account
checks consume API quota. No Environment or item is created or modified.
