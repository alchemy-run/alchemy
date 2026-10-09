# Foldkit rendering coverage

`FoldkitBuild.test.ts` exercises real Foldkit builds for the AWS, Node and Neon
targets in SSG, SSR and hybrid modes, plus SPA and static-only AWS output.
`packages/frontend-frameworks/src/foldkit/test/targets.test.ts` covers target
packaging and HTTP contracts independently of cloud deployments.

Each provider's `Website/FoldkitRendering.test.ts` checks these modes:

| Mode | Expected behavior |
| --- | --- |
| SPA / CSR | HTML shell on root and deep links; browser renders the counter |
| SSG | All declared pages are prerendered and hydrated; unknown pages return 404 |
| SSR | Request query determines the rendered counter on every page |
| Hybrid / prerendering | `/` and `/about` retain their build-time counter; other pages render per request |
| Static-only SSG (AWS) | Prerendered pages and browser interaction without a server; unknown pages return 404 |

HTTP cases also check JavaScript delivery, asset and page HEAD requests, missing
assets, and POST requests to a prerendered route. Browser cases check the initial
counter, increment it, reload, and increment it again. This exercises both client
startup and hydration with server-provided flags.

## Contributor execution

No CI workflow changes are required. These are live tests: use the existing
provider credentials/profile. Fly, Hetzner, Railway, Neon, Prisma and Cloudflare
cases create and destroy their own deployments and verify deletion through the
provider API. All cases skip under `FAST`; Hetzner also requires `HCLOUD_TOKEN`,
and Prisma retains its `ALCHEMY_RUN_LIVE_PRISMA_TESTS=true` gate.

Run individual cases to keep each invocation bounded, for example from the repo
root:

```sh
timeout 240 pnpm test test/Cloudflare/Website/FoldkitRendering.test.ts --profile testing --test-name-pattern 'hybrid: HTTP rendering' --timeout 120000 --retry 0 --concurrency 1
```

Browser cases are separately reported as skipped unless
`FOLDKIT_WEBSITE_BROWSER=1`. They require the `terminal-browser` CLI used by the
existing Neon website browser tests. With that variable set, select a
`browser hydration` case instead. A missing or failing browser executable fails
the enabled test.

## AWS deployments

CloudFront provisioning and deletion exceed the per-test timeout budget. The AWS
rendering suite therefore uses contributor-prepared deployments and does not
create or delete them. The existing AWS Foldkit lifecycle suite remains separate.

Set one or more public origins:

- `FOLDKIT_AWS_SPA_URL`
- `FOLDKIT_AWS_SSG_URL`
- `FOLDKIT_AWS_SSR_URL`
- `FOLDKIT_AWS_HYBRID_URL`
- `FOLDKIT_AWS_STATIC_URL`

Use fixtures matching `foldkitFixture(mode)` in `FoldkitRendering.ts`: the existing
Cloudflare Foldkit SPA/SSR fixtures, with `public/foldkit-probe.txt` containing
`FOLDKIT_STATIC_ASSET` (no trailing newline). For SSR disable prerendering; for
SSG/hybrid/static prerender `/` and `/about`. Static fixtures also supply
`public/404.html`. SSG fixtures reject paths outside `/` and `/about` and return
405 for non-GET/HEAD page requests.

Deploy through `AWS.Website.Foldkit`: leave `output` unset for SPA, use
`output: "server"` for SSG/SSR/hybrid, and `output: "static", errorPage: "404.html"`
for static-only SSG. Missing origins produce explicit skipped cases. Contributors
own cleanup of these separately prepared deployments.

The hybrid POST assertion requires the AWS edge router to send non-GET/HEAD
requests to SSR even when a matching prerendered file exists. It intentionally
checks this contract rather than accepting an S3 error response.

## GCP deployments

Cloud Run image publication and rollout also exceed the per-test budget. Use
contributor-prepared `GCP.Website.Foldkit` deployments with the same fixtures,
and set `FOLDKIT_GCP_SPA_URL`, `FOLDKIT_GCP_SSG_URL`, `FOLDKIT_GCP_SSR_URL` or
`FOLDKIT_GCP_HYBRID_URL`. The rendering suite checks HTTP and opt-in hydration;
contributors own cleanup. The existing Cloud Run lifecycle suite remains separate.
