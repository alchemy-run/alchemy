# STACKIT Static Site

Deploys the plain files in `site/` to STACKIT with `Stackit.Website.StaticSite`.
They sit in a private `Stackit.ObjectStorage.Bucket` behind a
`Stackit.CDN.Distribution`. No compute runs.

> This example has not been deployed to STACKIT yet.

```ts
const site = yield* Stackit.Website.StaticSite("MarketingSite", {
  command: "rm -rf dist && cp -R site dist",
  shell: true,
  outdir: "dist",
});
```

- Replace `command` and `outdir` with your own build, such as `hugo --minify` and `public`.
- `site/docs/index.html` is served at `/docs` and `/docs/`.

The CDN has no rewrite and no error pages, so a deep link to a route with no file
fails, and there is no 404 page. A bucket has no object for `/`, and STACKIT documents
no default document for a bucket origin, so check `/` on your first deploy.

## Prerequisites

A STACKIT project and a service account in an Alchemy profile. See
[Setup](https://alchemy.run/stackit/setup).

This site needs no registry and no STACKIT Functions access. For a client-side
routing fallback or a 404 page, deploy a `Stackit.Website.Vite` with
`origin: "function"`, which needs both: Functions is an alpha API available in
`eu01` only, and its image goes to a registry.

## Deploy

```sh
bun run deploy
```

`url` is the CDN's URL. Unchanged files skip the build and the upload on subsequent
deploys: the input files are content-hashed (scoped by `memo.include`).

## Dev

```sh
bun run dev
```

`alchemy dev` runs the build and serves the output with a local static server. No
cloud resources are created.

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
