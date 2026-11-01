# STACKIT Website: Foldkit

Deploys a [Foldkit](https://foldkit.dev) site to STACKIT with
`Stackit.Website.Foldkit`, with no adapter setup in the project config.
The build's files sit in a private `Stackit.ObjectStorage.Bucket` behind a
`Stackit.CDN.Distribution`. No compute runs.

> This example has not been deployed to STACKIT yet.

- `src/main.ts` holds the Elm-architecture model, update and view.
- `src/components/Card.ts` is a view function styled with Tailwind utilities.
- This is a client-only Foldkit app (`output: "spa"`, the default), so the deploy is assets-only.

```ts
const site = yield* Stackit.Website.Foldkit("Foldkit");
```

The CDN has no rewrite and no error pages, so a deep link to a route with no file
fails, and there is no 404 page. A bucket has no object for `/`, and STACKIT documents
no default document for a bucket origin, so check `/` on your first deploy.

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Prerequisites

A STACKIT project and a service account in an Alchemy profile. See
[Setup](https://alchemy.run/stackit/setup).

This site needs no registry and no STACKIT Functions access. `origin: "function"`
serves the same files from a Function, which gives you
`assets.notFoundHandling`, and it needs both: Functions is an alpha API available
in `eu01` only, and its image goes to a registry.

## Deploy

```sh
bun run deploy
```

`url` is the CDN's URL. Unchanged sources skip the build on subsequent deploys: the
input files are content-hashed (scoped by `memo.include`).

## Dev

```sh
bun run dev
```

`alchemy dev` runs the framework's own dev server (HMR included) and no cloud
resources are created.

## Test

```sh
ALCHEMY_PROFILE=<profile> bun test test/integ.test.ts
```

The suite deploys the stack, checks that the CDN's origin is a bucket, calls the site
through the CDN, and destroys the stack. It skips without STACKIT credentials in the
environment or `ALCHEMY_PROFILE`.

## Destroy

```sh
bun run destroy
```
