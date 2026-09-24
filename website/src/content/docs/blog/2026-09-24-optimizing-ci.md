---
title: Optimizing Alchemy's CI Workflows
date: 2026-09-24T16:00:00Z
excerpt: We moved CI to Blacksmith, fixed our caches, switched to pnpm, stopped running work nobody asked for, and cut the website build from 162s to 39s.
---

Alchemy is a monorepo of almost 100 packages (86 of them are
[distilled](https://github.com/alchemy-run/distilled) SDKs) as of
writing this, a website with thousands of
generated pages, and a release pipeline that publishes to npm. A check
run took ~8 minutes and Cloudflare tooling ~16.

## Runners and tooling

We moved our workflows to
[Blacksmith](https://blacksmith.sh/?ref=alchemy.run) runners
([#1162](https://github.com/alchemy-run/alchemy/pull/1162)). That
alone made a difference:

| Workflow | Before | After | |
|---|---:|---:|---:|
| check | 7.8 min | 4.8 min | −38% |
| cloudflare-tools | 16.2 min | 5.3 min | −67% |
| pr-package | 5.0 min | 3.2 min | −36% |

We also moved the workspace from Bun workspaces to pnpm
([#1214](https://github.com/alchemy-run/alchemy/pull/1214)).

Releases are the one exception. npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) only
accepts OIDC tokens from GitHub-hosted runners, GitLab.com, and
CircleCI cloud. So we had to split releases in two: build on Blacksmith,
publish on GitHub.

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

## Caching the website

[Astro 7.2](https://astro.build/blog/astro-720/) shipped
[experimental incremental builds](https://docs.astro.build/en/reference/experimental-flags/incremental-build/),
which skip pages that haven't changed. We enabled it, patched Starlight
to support it, and persisted the cache across CI runs
([#1128](https://github.com/alchemy-run/alchemy/pull/1128),
[#1136](https://github.com/alchemy-run/alchemy/pull/1136)). A warm
build now restores almost every page and OG image.

Our website deploy and docs check shared the same cache keys while
building different things, so we gave each its own
([#1285](https://github.com/alchemy-run/alchemy/pull/1285)).

## Building less of the website

The API reference had one page per resource, 4,368 in total. We merged
them into one page per service
([#1767](https://github.com/alchemy-run/alchemy/pull/1767),
[#1774](https://github.com/alchemy-run/alchemy/pull/1774)).

| | Before | After |
|---|---:|---:|
| Reference pages | 4,368 | 406 |
| Cold build | 162 s | 39 s |
| Website CI run (median) | 8.0 min | 4.1 min |

PR previews used to deploy a new Worker each time. Now they're versions
of a single preview Worker, so assets already uploaded from `main` are
reused ([#1267](https://github.com/alchemy-run/alchemy/pull/1267)).

## Only run what changed

We went through our runs to find where we were burning minutes
([#1362](https://github.com/alchemy-run/alchemy/pull/1362)):

- New pushes cancel older runs on the same PR.
- Workflows skip changes that don't affect them. Cloudflare tooling
  only runs when its packages change.
- Website Workers keep stable names, so wiping our test account doesn't
  force a full asset upload.

Package CI reruns and website previews are now opt-in through PR labels
([#1431](https://github.com/alchemy-run/alchemy/pull/1431)).

## `pkg`: our own preview registry

[`@alchemy.run/pkg`](https://github.com/alchemy-run/alchemy/pull/1516)
publishes every PR's packages to an installable URL, like
[pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new). We built
our own as soon as we hit pkg.pr.new's limits, and we host it on
Cloudflare with Alchemy.

We first optimized it as a stopgap: packages are stored by content
hash, so unchanged ones are never uploaded again
([#1145](https://github.com/alchemy-run/alchemy/pull/1145)). Then we
rewrote it:

- Fork PRs can publish without secrets, because each publish is
  verified against the GitHub Actions run that built it
  ([#1681](https://github.com/alchemy-run/alchemy/pull/1681)).
- Previews can publish only the packages a change affects
  ([#1727](https://github.com/alchemy-run/alchemy/pull/1727)).
- Previews stay alive while their PR is open
  ([#1511](https://github.com/alchemy-run/alchemy/pull/1511)).

## Thanks, Blacksmith

Thanks to [Blacksmith](https://blacksmith.sh/?ref=alchemy.run) for
sponsoring our CI runners. Their fast Linux, macOS, and Windows runners
help us test our packages across platforms and deploy our content-heavy
website in mere minutes. They also went through our workflow runs and
helped us figure out the bad parts of our CI setup.
