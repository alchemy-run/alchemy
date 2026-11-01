# STACKIT Service on a server

An Effect program on a `Stackit.IaaS.Server`, as a `Stackit.IaaS.Service`: a systemd unit running bun. Nothing logs in to the server. Alchemy drives it through STACKIT Run Command, so no SSH is opened, and no key sits on the server.

```sh
curl "$URL/"
# hello from a server
curl "$URL/commands"
# {"items":[…]}
```

## Architecture

- [`src/server.ts`](./src/server.ts): a network, a security group with the program's port open, an interface, a `g1.1` server, and a public IP.
- [`src/Api.ts`](./src/Api.ts): the program. Each deploy bundles it on your machine, hands it to the server through a bucket and a presigned URL, and restarts the unit. It doesn't use Docker.

## Bindings

| Host | Binding                                                     | Access                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Api  | `Stackit.RunCommand.ListCommands(server)` + `ListCommandsHttp` | One service account for the server, attached to it. The program gets short-lived tokens from the server's metadata API. Grants are project-scoped, the narrowest scope STACKIT binds. |

Services on one server share that account and each other's grants.

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).
- `iam.service-account.act-as` for your deployer on the account Alchemy creates. If creating the account doesn't grant it, give the deployer `iam.service-account-user`.

## Cost

About **EUR 0.05 per hour** (price list v1.0.44): `g1.1` at EUR 0.038, a 10 GB boot volume at about EUR 0.01, and a public IP at about EUR 0.004. The bucket the program passes through holds nothing between deploys.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-service
pnpm run deploy --profile <name>
```

## Test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, calls the program, checks through the API that the server is active with one service account attached, then destroys the stack and checks that the server is gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- The Server Agent answers after the server turns `ACTIVE`. The server sets `agent: { provisioned: true }`.
- The server reaches `bun.sh` and Object Storage over outbound HTTPS.
- The metadata API's token: the program signs with it, and `GET /commands` fails if it can't.

## Destroy

```sh
pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
pnpm destroy --profile <name> --stage test_$USER
```
