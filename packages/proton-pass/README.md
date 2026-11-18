# @alchemy.run/proton-pass

Read Proton Pass items or `pass://` references into an [Alchemy](https://alchemy.run)
stack's Effect Config through the [Proton Pass CLI](https://protonpass.github.io/pass-cli/).
Use the CLI's own login locally and `PROTON_PASS_PERSONAL_ACCESS_TOKEN` in CI.

```sh
pnpm add alchemy @alchemy.run/proton-pass effect
```

```typescript
import * as ProtonPass from "@alchemy.run/proton-pass";

const secrets = [
  ProtonPass.Item(({ stage }) => ({
    vault: "Alchemy",
    item: stage === "prod" ? "app-production" : "app-development",
  })),
];
// Pass secrets to Alchemy.Stack and read values with Config.Redacted.
```

Or map config keys to individual fields, alone or next to an item:

```typescript
ProtonPass.SecretReferences({
  references: {
    DATABASE_URL: "pass://Production/Database/password",
    API_KEY: "pass://Production/API/Staging.key",
  },
});
```

Every reference is read when the stack loads. A missing or malformed reference
fails the whole load, naming its config key.

Locally, run `pass-cli login`. In CI, set `PROTON_PASS_PERSONAL_ACCESS_TOKEN` to
a token with viewer access to the vaults you load. Alchemy logs it in to a
temporary session and logs it out afterwards, so your own CLI session is never
replaced. You can also store a token with
`alchemy profile edit --add ProtonPass --method personal-access-token --set token=-`.

The provider never writes downloaded values to `process.env` or disk, and never
puts the token on a command line.

- [Setup and troubleshooting](https://alchemy.run/environments/proton-pass)
- [Secret providers](https://alchemy.run/environments/secret-providers)

## Development checks

Run the offline tests from the repository root:

```sh
pnpm test:integration test/proton-pass
```

Live tests are opt-in and read-only. Create a vault (default `alchemy-test`,
override with `PROTON_PASS_TEST_VAULT`) holding a custom item `alchemy-fixture`
with these fields:

| Section | Field | Value |
| --- | --- | --- |
| any | `ALCHEMY_PROTON_PASS_TEST` | `ready` |
| any | `MULTILINE` | `line one` + newline + `line "two" = x` |
| any | `EMPTY` | empty |
| `Staging` | `API_KEY` | `staging-ready` |

Then set `PROTON_PASS_TEST_LIVE=1`. Without `PROTON_PASS_PERSONAL_ACCESS_TOKEN`
the tests read through your `pass-cli login` session. With it set, they read
through a token, which must have viewer access to the vault. No item is created
or modified.
