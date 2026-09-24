---
title: Optimizing Alchemy's CI Workflows
date: 2026-09-24T16:00:00Z
excerpt: We moved CI to Blacksmith, fixed our caches, switched to pnpm, stopped running work nobody asked for, and cut the website build from 162s to 39s.
---

Alchemy is a monorepo of 100+ packages, a website with thousands of
generated pages, and a release pipeline that publishes to npm. A check
run took ~8 minutes and Cloudflare tooling ~16.

## Groundwork: incremental Astro builds

Before touching runners we made the website cacheable.
[Astro 7.2](https://astro.build/blog/astro-720/) shipped
[experimental incremental static builds](https://docs.astro.build/en/reference/experimental-flags/incremental-build/):
a page is skipped when its `cacheKey` and module graph match the
previous build. We enabled it and patched Starlight so its routes
return cache keys
([#1128](https://github.com/alchemy-run/alchemy/pull/1128)). The
Astro cache is persisted across CI runs, and the docs check reuses
it ([#1136](https://github.com/alchemy-run/alchemy/pull/1136)).

A warm build now restores 4,188 of 4,195 HTML routes and all 4,197
OG images instead of rendering them.

## Moving to Blacksmith

We moved our workflows to
[Blacksmith](https://blacksmith.sh/?ref=alchemy.run) runners
([#1162](https://github.com/alchemy-run/alchemy/pull/1162)). The
change is one line per job:

```diff lang="yaml"
-    runs-on: ubuntu-latest
+    runs-on: blacksmith-4vcpu-ubuntu-2204
```

Switching to Blacksmith alone made a difference. Median durations of
successful runs, before and after:

| Workflow | Before | After | |
|---|---:|---:|---:|
| check | 7.8 min | 4.8 min | −38% |
| cloudflare-tools | 16.2 min | 5.3 min | −67% |
| pr-package | 5.0 min | 3.2 min | −36% |

## pnpm

We migrated the workspace from Bun workspaces to pnpm catalogs
([#1214](https://github.com/alchemy-run/alchemy/pull/1214)).

## Publishing to npm from a GitHub runner

npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
only accepts OIDC tokens from GitHub-hosted runners, GitLab.com shared
runners, and CircleCI cloud. Blacksmith runners, self-hosted runners,
and every other CI provider are locked out.

So we had to split releases into two jobs. Everything expensive (install,
build, validate) runs on Blacksmith. Only the final `npm publish` runs
on a GitHub-hosted runner:

```yaml
jobs:
  build:
    runs-on: blacksmith-8vcpu-ubuntu-2404
  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      id-token: write
```

We don't want this extra job, but npm has yet to allow OIDC auth from
any other CI provider.

## Fixing cache conflicts

The website deploy and the docs check published identical `astro-*`
cache keys while running different builds, so each seeded the other
with the wrong output. They now have separate namespaces
([#1285](https://github.com/alchemy-run/alchemy/pull/1285)).

## PR website previews as Worker versions

Every PR preview used to create its own Worker script and upload the
full site. Previews are now zero-traffic versions of one permanent
`preview-base` Worker, refreshed from `main`
([#1267](https://github.com/alchemy-run/alchemy/pull/1267)). Assets
already uploaded for `main` don't need uploading again.

## Only run what changed

We looked through our workflow runs for where we were burning
minutes. That turned into
[#1362](https://github.com/alchemy-run/alchemy/pull/1362):

- Concurrency groups cancel superseded PR runs.
- Path filters skip workflows unrelated to the change. Cloudflare
  tooling only runs when the runtime, test tools, frameworks, or the
  lockfile change.
- The website Workers keep the same name across runs. Our test
  account is wiped regularly, and a freshly named Worker has to
  upload every asset again.

Concurrency groups have sharp edges. On `pull_request: closed`,
`github.ref` resolves to the base branch, so every merged PR's
cleanup run landed in `main`'s deploy group and cancelled queued
deploys, including a production release deploy. Keying the group by
target stage fixed it
([#1420](https://github.com/alchemy-run/alchemy/pull/1420)).

We then made the expensive paths opt-in: package CI reruns on the
`force-ci` label and website previews on `deploy-website`
([#1431](https://github.com/alchemy-run/alchemy/pull/1431)).

## Building fewer pages

The API reference generated one page per resource: 4,368 pages, each
rendering the full layout and sidebar. We merged them into service
pages with resource anchors
([#1767](https://github.com/alchemy-run/alchemy/pull/1767)), then
split flat providers by product
([#1774](https://github.com/alchemy-run/alchemy/pull/1774)). Old
URLs redirect.

| | Before | After |
|---|---:|---:|
| Reference pages | 4,368 | 406 |
| Cold build | 162 s | 39 s |
| Website CI run (median) | 8.0 min | 4.1 min |

## `pkg`: our own preview registry

[`@alchemy.run/pkg`](https://github.com/alchemy-run/alchemy/pull/1516)
publishes every PR's packages to an installable URL, like
[pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new). It's a
registry on Cloudflare Workers plus a CLI, deployed with Alchemy, so
we host it ourselves and set our own limits on package size, retention,
and which repos can publish.

We built our own preview flow as soon as we ran into pkg.pr.new's
limits. As a stopgap we optimized it into one
content-addressed publish job with tarballs keyed by SHA-256, so
unchanged packages were never re-uploaded
([#1145](https://github.com/alchemy-run/alchemy/pull/1145)). Then we
rewrote it. `pkg` verifies each publication against the GitHub Actions
run that built it, so fork PRs publish with no permissions and no
secrets ([#1681](https://github.com/alchemy-run/alchemy/pull/1681)).

Previews can now publish only affected packages: what changed, its
dependents, and the dependencies they need
([#1727](https://github.com/alchemy-run/alchemy/pull/1727)). A
Cloudflare-only change no longer rebuilds every SDK. Previews also
stay alive for as long as their PR is open
([#1511](https://github.com/alchemy-run/alchemy/pull/1511)).

## Thanks, Blacksmith

Thanks to [Blacksmith](https://blacksmith.sh/?ref=alchemy.run) for
sponsoring our CI runners. Their fast Linux, macOS, and Windows runners
help us test our packages across platforms and deploy our content-heavy
website in mere minutes. They also went through our workflow runs and
helped us figure out the bad parts of our CI setup.
