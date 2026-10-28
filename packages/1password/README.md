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

Run the mocked provider tests from the repository root:

```sh
pnpm test:integration test/1password
```

Live tests are opt-in and read-only. Create an Environment containing
`ALCHEMY_ONEPASSWORD_TEST=ready`, then set `ONEPASSWORD_TEST_LIVE=1` and
`ONEPASSWORD_TEST_ENVIRONMENT_ID`. Export `OP_SERVICE_ACCOUNT_TOKEN` for the
service-account check, or `ONEPASSWORD_TEST_DESKTOP_ACCOUNT` for the desktop
check. The desktop test prompts for authorization. Neither test prints values
or retries errors; the service-account test consumes API quota.

To opt into the vault-reference test, also set `ONEPASSWORD_TEST_REFERENCE` to
an `op://vault/item/[section/]field` whose value is `ready`. The service account
must have read access to that vault. No item is created or modified.
