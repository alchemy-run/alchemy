# STACKIT Website: Vocs

Deploys a [Vocs](https://vocs.dev) site to STACKIT with
`Stackit.Website.Vocs`, with no adapter setup in the project config.
The site runs on a `Stackit.Functions.Function` behind a
`Stackit.CDN.Distribution`.

> This example has not been deployed to STACKIT yet.

- `vocs.config.ts` is loaded natively by Vocs.
- `src/pages/*.mdx` holds the documentation pages.
- `public/hello.txt` shows static passthrough assets.

```ts
const site = yield* Stackit.Website.Vocs("VocsDocs", {
  ...hosting,
});
```

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Prerequisites

- A STACKIT project and a service account in an Alchemy profile. See
  [Setup](https://alchemy.run/stackit/setup).
- Access to STACKIT Functions, an alpha API available in `eu01` only. Your
  profile's region must be `eu01`.
- Docker on the machine you deploy from. It builds the site's image.
- A registry. A server-rendered site runs from an OCI image, so it needs somewhere
  to push it. `alchemy.run.ts` creates a `Stackit.ContainerRegistry.Project` and
  its robot accounts, which takes a Harbor user's CLI secret, from the user profile
  in the registry's web UI. STACKIT credentials don't provide it:

  ```sh
  export HARBOR_USERNAME=...
  export HARBOR_CLI_SECRET=...
  ```

  To use another registry, drop `hosting` and pass
  `registry: { repository: "ghcr.io/my-org/web" }`. The image is then pushed with
  your machine's `docker login`, and a private image needs a
  `Stackit.Functions.PullCredential`.

## Deploy

```sh
bun run deploy
```

`url` is the CDN's URL and `serverUrl` is the function's. Unchanged sources skip
the build on subsequent deploys: the input files are content-hashed (scoped by
`memo.include`).

## Dev

```sh
bun run dev
```

`alchemy dev` runs the framework's own dev server (HMR included) and no cloud
resources are created, so `alchemy.run.ts` leaves out the registry.

## Test

```sh
STACKIT_TEST_FUNCTIONS=1 ALCHEMY_PROFILE=<profile> bun test test/integ.test.ts
```

The suite deploys the stack, checks that the CDN's origin is the function, calls the
site through the CDN and on the function, and destroys the stack. It skips unless
`STACKIT_TEST_FUNCTIONS`, `HARBOR_USERNAME` and `HARBOR_CLI_SECRET` are set.

## Destroy

```sh
bun run destroy
```
