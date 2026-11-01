# STACKIT Container Applications

Two `Stackit.ContainerApplications.Application`s in one environment: an Effect program built from your source, and a public nginx image with no build.

```sh
curl "$URL/"
# hello from a container application
curl "$URL/zone"
# {"zoneId":"5f0c…"}
curl "$WEB_URL/"
# <h1>Welcome to nginx!</h1> …
```

## Architecture

- [`src/Api.ts`](./src/Api.ts): the Effect program. Alchemy builds its image with Docker on your machine and pushes it to the registry project. It runs at most one instance and may scale to zero.
- [`src/resources.ts`](./src/resources.ts): the DNS zone the program reads, and `Web`, one fixed instance of a public image.
- [`src/registry.ts`](./src/registry.ts): the environment, the registry project, and its logins.

## Bindings

| Host | Binding                                       | Access                                                                                                                                                  |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Api  | `Stackit.DNS.GetZone(Domain)` + `GetZoneHttp` | A service account for this application, with a key that reaches it as an environment secret. `dns.zone.list` on the project, the narrowest scope STACKIT binds. |

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).
- Docker running on your machine.
- A registry login: `HARBOR_USERNAME` and `HARBOR_CLI_SECRET`, your Harbor user and CLI secret from your user profile in the registry UI.
- Access to Container Applications, a beta API in `eu01` only.

## Cost

`Web` runs one instance for as long as the stack is deployed. STACKIT's price list (v1.0.44) has no SKU for Container Applications, so the hourly cost is unknown. The DNS zone bills about EUR 0.003 to EUR 0.004 per hour on top. Check the current price list, and destroy the stack when you're done. Container Registry is free during its beta.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-container-app
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, calls both applications, reads `Web` through the API, then destroys the stack and checks that both applications are gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- The API takes a pinned image reference (`repo@sha256:...`). The spec only shows a bare name.
- The applications run on `linux/amd64` images, which Alchemy assumes.
- The service enablement id `cloud.stackit.sca`. No source names it.

## Destroy

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name> --stage test_$USER
```

The API can't delete a Container Applications environment, so a destroy leaves `Apps` behind. Its generated name is stable, so the next deploy finds it again.
