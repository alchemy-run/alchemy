# Bare STACKIT server

A `Stackit.IaaS.Server` running a program you start yourself: cloud-init writes a page on first boot and serves it with Python. There is no Alchemy runtime on the server. To deploy an Effect program to a server, see [`stackit-service`](../stackit-service).

```sh
curl "$URL/"
# hello from a bare server
```

## Architecture

Everything is in [`alchemy.run.ts`](./alchemy.run.ts): a network, a security group with port `8080` open, an interface, a `g1.1` server with a 10 GB boot volume, and a public IP.

No port 22 is open and the server has no key pair. Add a `Stackit.IaaS.KeyPair`, set `keypairName`, and add a rule for port 22 to log in. Changing `userData` replaces the server.

## Prerequisites

A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).

## Cost

About **EUR 0.05 per hour** (price list v1.0.44): `g1.1` at EUR 0.038, a 10 GB boot volume at about EUR 0.01, and a public IP at about EUR 0.004. Networks and security groups are free. A project's first network with internet access also adds a small SNAT gateway charge.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-server
pnpm run deploy --profile <name>
```

## Test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, reads the server through the API, fetches the page from the public address, then destroys the stack and checks that the server and the network are gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- The newest public Ubuntu image ships `python3` and cloud-init, and runs `runcmd` from `userData`.
- Machine type `g1.1` is available in your region, with `listMachineTypes`.

## Destroy

```sh
pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
pnpm destroy --profile <name> --stage test_$USER
```
