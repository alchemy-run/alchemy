---
title: Optimizing Alchemy's CI Workflows
date: 2026-09-24T16:00:00Z
excerpt: Moving CI to Blacksmith, fixing cache bugs, switching to pnpm, running CI conditionally and cut website build times from 162s to 39s.
---

As of writing this, Alchemy is a monorepo of almost 100 packages (86 of them are [distilled](https://github.com/alchemy-run/distilled) SDKs), with a docs website with thousands of generated pages, regular CI checks, preview package publishing, tests for our local cloudflare runtime and a release pipeline that publishes to npm. Over past few weeks we made several CI improvements to make it so the contributors and their agents can iterate fast.

## Swapping out GitHub runners
Our first immediate improvement came from moving our workflows to [Blacksmith](https://blacksmith.sh/?ref=alchemy.run) runners ([#1162](https://github.com/alchemy-run/alchemy/pull/1162)). Just by doing that we had very comparable numbers to look at: 

| Workflow | Before | After | |
|---|---:|---:|---:|
| check | 7.8 min | 4.8 min | −38% |
| cloudflare-tools | 16.2 min | 5.3 min | −67% |
| pr-package | 5.0 min | 3.2 min | −36% |

We also changed out our package manager from bun to pnpm ([#1214](https://github.com/alchemy-run/alchemy/pull/1214)) which behaves better in general and doesn't have weird issues.

All of our CI jobs runs on Blacksmith, expect for npm releases. Npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/) only allows trusted publishing from GitHub-hosted runners, GitLab.com, and CircleCI cloud. So we had to split releases in two job: build on Blacksmith, publish on GitHub.

```yaml  
name: Release
jobs:
  build:
    runs-on: blacksmith-8vcpu-ubuntu-2404  
    # Build, Pack, Upload tarballs  
  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      id-token: write  
    # Publish tarballs using pnpm publish which handles everything
```

We don't want this extra complexity, but npm has yet to allow trusted publishing from any other CI provider.

## Fixing our website deploys 

Our docs site is a content heavy site, it used to have over 4k+ pages (and paired OG image for each page), most of them are just generated specs from our inline jsdocs, It would take upto 25 min building and deploying all those pages and assets. [Astro 7.2](https://astro.build/blog/astro-720/) shipped [experimental incremental builds](https://docs.astro.build/en/reference/experimental-flags/incremental-build/), which skip bulding pages that haven't changed. We enabled it, patched Starlight to support it, and persisted the cache across CI runs ([#1128](https://github.com/alchemy-run/alchemy/pull/1128), [#1136](https://github.com/alchemy-run/alchemy/pull/1136)). A warm build restored most of the page and allmost all OG images.

The API reference had one page per resource, 4,368 in total. We merged them into one page per service ([#1767](https://github.com/alchemy-run/alchemy/pull/1767), [#1774](https://github.com/alchemy-run/alchemy/pull/1774)), and it did the biggest improvement so far.

| | Before | After |
|---|---:|---:|
| Reference pages | 4,368 | 406 |
| Cold build | 162 s | 39 s |
| Output size | 3.64GB | 438MB |
| Website CI run (median) | 8.0 min | 4.1 min |

PR previews used to deploy a new Worker each time. Now they're versions of a single preview Worker, so assets already uploaded from `main` are reused ([#1267](https://github.com/alchemy-run/alchemy/pull/1267)). Website deploys on PRs are only trigged when `deploy-website` tag is used, and doesn't work on fork PRs yet.

## Conditional Test runs, worflow concurrency and cancelation

We went through our runs to find where we were burning minutes ([#1362](https://github.com/alchemy-run/alchemy/pull/1362)):

- New pushes cancel older runs on the same PR.
- Workflows skip changes that don't affect them. Cloudflare tooling only runs when its packages change.
- Website Workers keep stable names, so wiping our test account doesn't force a full asset upload.

## Using `pkg.alchemy.run`

[`@alchemy.run/pkg`](https://github.com/alchemy-run/alchemy/pull/1516) publishes every PR's packages to an installable URL, like [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new). We built our own as soon as we hit pkg.pr.new's limits, and we host it on Cloudflare with Alchemy.
We first optimized it as a some time after, packages are stored by content hash, so unchanged ones are never uploaded again ([#1145](https://github.com/alchemy-run/alchemy/pull/1145)). Then we rewrote it recently:

- Fork PRs can publish without secrets, because each publish is verified against the GitHub Actions run that built it ([#1681](https://github.com/alchemy-run/alchemy/pull/1681)).
- Previews can publish only the packages a change affects ([#1727](https://github.com/alchemy-run/alchemy/pull/1727)).
- Previews stay alive while their PR is open ([#1511](https://github.com/alchemy-run/alchemy/pull/1511)).

## Thanks to Blacksmith

Thanks to [Blacksmith](https://blacksmith.sh/?ref=alchemy.run) for sponsoring our CI runners. Their fast Linux, macOS, and Windows runners help us test our packages across platforms and deploy our content-heavy website and more without having to wait forever.