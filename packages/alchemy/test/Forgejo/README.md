# Forgejo verification

Run all commands below from the repository root. Ordinary `pnpm test test/Forgejo`
runs unit and bundle-boundary tests without a server or cloud deployment.
Live tests are explicitly enabled and must run sequentially because they share
fixture accounts and the webhook receiver port.

## Real Forgejo lifecycles

Docker is required. The bootstrap starts only `alchemy-forgejo-1425`, pinned to
Forgejo 16.0.3, with 1 GiB memory and two CPUs. HTTP is bound to loopback port
31425. Credentials are written to the ignored `.alchemy/forgejo/fixture.json`
with restricted filesystem permissions; do not publish that file or test state.

```sh
bun packages/alchemy/test/Forgejo/support/fixture.ts
FORGEJO_TEST=1 timeout 240 pnpm test test/Forgejo --profile testing --retry 0 --concurrency 1
bun packages/alchemy/test/Forgejo/support/fixture.ts check
```

Lifecycle tests use the real APIs and engine. `FORGEJO_TEST_CONFIG` can name an
alternative fixture JSON containing `baseUrl`, `token`, and `username`.
The credential must administer the disposable instance. The webhook lifecycle
tests listen on port 31426; external servers additionally need `webhookUrl`
pointing to that listener. The pinned local fixture is the supported acceptance
configuration; the runtime suite below also relies on its administrator account.

## Deployed Worker and Lambda bindings

The `testing` profile must have Cloudflare and AWS credentials authorized to
create and delete test Workers, Lambda functions, and their supporting resources.
AWS SSO must be logged in. The Forgejo fixture needs a public HTTPS tunnel so
those deployed hosts can reach it. Start a task-owned tunnel in a separate terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:31425 --no-autoupdate > .alchemy/forgejo/runtime-tunnel.log 2>&1
```

Prepare an isolated profile home. This copies the testing configuration and adds
the fixture's Forgejo credential without changing the user's profiles:

```sh
bun packages/alchemy/test/Forgejo/support/runtime-profile.ts
```

Run the complete suite, enabling both real lifecycle and deployed-host cases:

```sh
ALCHEMY_HOME="$PWD/.alchemy/forgejo/runtime-home" \
FORGEJO_TEST=1 FORGEJO_RUNTIME_TEST=1 \
timeout 240 pnpm test test/Forgejo --profile testing --retry 0 --concurrency 1
```

The runtime transport maps only the owned tunnel's deployment API requests to
the same real Forgejo server on loopback, avoiding local DNS propagation delays.
Deployed hosts use the public URL. Requests are not mocked. Tests verify
restricted-token permissions, deduplication, rotation, external-credential
ownership, generated signing secrets, actual push/issue deliveries, invalid
signatures, host replacement, and resource cleanup.

## Cleanup

Run the independent fixture census after the suites. Stop the task-owned tunnel,
then remove the disposable container and volume:

```sh
bun packages/alchemy/test/Forgejo/support/fixture.ts check
bun packages/alchemy/test/Forgejo/support/fixture.ts down
```

A passing local census does not replace checking successful host deletion in the
runtime suite logs. Avoid account-wide cleanup commands: these suites own only
the resources declared in their scratch stacks.
