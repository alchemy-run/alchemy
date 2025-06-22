# Contributing

## Pre-requisites

1. [Bun](https://bun.sh)

```sh
curl -fsSL https://bun.sh/install | bash
```

## Install

We use bun workspaces, so a simple `bun i` installs all the dependencies:

```sh
bun i
```

## Build

To compile all typescript and bundle the CLI, run:

```sh
bun run build
```

## Check

Type-check and lint (with biome):

```sh
bun check
```

## Test

All tests are in `./alchemy/test/*` or `./alchemy/test/{providerName}/*` and we use Vitest as our test runner.

> [!CAUTION]
> Each provider requires its own credentials, and there are roughly 22 of them. The authoritative list can be found in the [Repository Stack](./stacks/src/repo.run.ts#L80).

When making a change, you can just run the relevant tests instead of setting up every secret.

E.g. to run the Cloudflare tests, you'll need to configure the following environment variables

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_KEY`
- `CLOUDFLARE_EMAIL`

And then run the tests:

```sh
bun vitest run ./alchemy/test/cloudflare
```

Or run a specific test suite:

```sh
bun vitest run ./alchemy/test/cloudflare/worker.test.ts
```

Or run a specific test:

```sh
bun vitest run ./alchemy/test/cloudflare/worker.test.ts -t "create, update, and delete worker (ESM format)"
```
