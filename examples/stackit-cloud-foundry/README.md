# STACKIT Cloud Foundry

An organization, a space, and two `Stackit.CloudFoundry.App`s: an Effect program with a binding, and a plain `fetch` handler typed with `Stackit.InferEnv`.

```sh
curl "$URL/"
# hello from an effect app
curl "$URL/space"
# {"spaceId":"5f0c…","name":"…"}
curl "$WEB_URL/"
# hello from an async app
```

## Architecture

- [`src/deployer.ts`](./src/deployer.ts): the organization, a manager, a space, and that manager's `space_developer` role, plus the registry project and the login it pushes and pulls with.
- [`src/Api.ts`](./src/Api.ts): the Effect program.
- [`src/resources.ts`](./src/resources.ts) and [`src/web.ts`](./src/web.ts): the async app and its handler.

Alchemy builds both images with Docker on your machine and pushes them to the registry project.

## Bindings

| Host | Binding                                                 | Access                                                                                                                                                       |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Api  | `Stackit.CloudFoundry.GetSpace(space)` + `GetSpaceHttp` | A service account for this app, with a key that reaches it as an environment variable. The role is granted on the project, the narrowest scope STACKIT binds. |

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).
- Docker running on your machine.
- A registry login: `HARBOR_USERNAME` and `HARBOR_CLI_SECRET`, your Harbor user and CLI secret from your user profile in the registry UI.

## Cost

A started app costs EUR 0.0000409 per MB per started hour (price list v1.0.44). Both apps here are 256 MB, so about **EUR 0.02 per hour** together. Organizations, spaces and quotas are free. Container Registry is free during its beta.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-cloud-foundry
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, calls both apps, compares the space the binding reads with the same space through the API, then destroys the stack and checks that the organization is gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- An organization manager can log in with its password. Everything on the Cloud Foundry API depends on it.
- The platform allows Docker images. If it doesn't, an app built from `main` fails to stage.
- A generated host label fits the shared domain.
- An organization's delete takes its spaces with it.

## Destroy

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name> --stage test_$USER
```
