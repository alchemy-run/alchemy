---
name: release-blog
description: Write the next alchemy release blog post — find the last `chore(release)` commit on origin/main, read the description of every PR merged since, plan the headline sections (Effect upgrades, new providers, new features, major bug fixes, breaking changes) with DX-first code snippets, fold the rest into "Also in this release", credit contributors, and check every link and diff block. Use for "write the release blog", "prepare the next release post", "/release-blog", "blog for beta.N".
metadata:
  internal: true
---

# Write the release blog

The post covers every PR merged to `origin/main` since the most recent
`chore(release)` commit, and announces the next version. The house rules for
release posts live in AGENTS.md ("Blog / Release Notes Conventions"); this
skill is the procedure. Read the last two posts in
`website/src/content/docs/blog/` (`*-beta-*.md`) before writing. They set the
voice, length and structure to match.

## 1. Collect every PR

```sh
.agents/skills/release-blog/scripts/collect-prs.sh /tmp/release-blog-<next>
```

It prints the release commit (`chore(release): 2.0.0-beta.N`, so the post is
for `beta.N+1`) and writes one JSON per PR, a `digest.txt` with every PR's
title, author and full body (oldest first), and `authors.txt` with every
non-maintainer author's display name.

## 2. Read every description in full

Read all of `digest.txt`, in chunks, start to finish. It holds whole bodies,
on purpose: a PR's later sections ("### Changes", a second snippet, a
"Removed" list) are where secondary features and renames hide, and a post
planned from excerpts folds them into a clause or drops them. Don't sample,
and don't skim by title: a `chore` or `test` title can carry a user-facing
fix, and a `feat` body often holds the best snippet for the post.

Tag each PR as you go:

- **breaking**: `!` in the title, or `Breaking`/`[!CAUTION]` in the body. Note
  the migration diff the PR gives. Unmarked PRs break things too: look for
  "renamed", "removed", "replaces", "is gone", "now requires", "`X` is now
  `Y`" and "was `X`" in every body. Confirm each one shipped in the last
  release (`git grep <old name> <release-sha> -- packages/`) before listing
  it; a rename of something added in this same release isn't breaking.
- **headline**: a dependency upgrade users must make (Effect, a framework
  major), a new provider or package, a new capability with a user-facing API,
  or a major bug fix (data loss, wrong resource deleted or taken over,
  deploys that hang or fail, large perf or bundle wins).
- **also**: smaller features and fixes users would notice.
- **skip**: internal only. CI, skills, lint and repo tooling, test-only PRs
  that fix no shipped behavior, distilled bumps without a user-visible change,
  docs restyles, and fix-ups of earlier PRs in the same release.

Group related PRs into one item: a stack of PRs for one feature is one
section, and a family of fixes (drift, ownership, local dev) is one bullet.

## 3. Plan before writing

Write the plan out first: the title, the breaking-change list, the ordered
headline sections with the PRs each one cites, and the also-list groups.

- **Title**: `2.0.0-beta.N - <three short items>`. It renders in the blog
  sidebar, so it must fit on one line.
- **Order the headlines** by how much they change a user's day: required
  upgrades (Effect) first, then new providers and packages, then the biggest
  new capabilities, then major fixes. There is no cap on the number of
  sections; a large release gets 25–30. Its size is set by what shipped.
- **A new user-facing API gets a snippet**, in its own section or in a
  section about its area (a "New AWS resources and options" section collects
  smaller ones). Never shrink one into a clause of an unrelated section: a
  reader skimming headings must find it. A PR that adds several APIs (a store
  that gains `accountId`, `workerName` and `domain` plus a new bootstrap
  command) is usually its own section.
- **Everything else** goes into `## Also in this release`, grouped by area
  (Cloudflare features, Cloudflare fixes, Local dev fixes, AWS features, AWS
  fixes, GCP, Domain, Auth, …), each group one bullet with its PR links.

## 4. Write it

File: `website/src/content/docs/blog/YYYY-MM-DD-beta-NN.md`, dated the
release day (ask if it isn't today). Frontmatter `title`, `date`,
`category: release` and a one-sentence `excerpt`.

- Open with two short paragraphs naming the headline features in bold.
- `:::caution` with **Breaking changes** at the top. Each item says what to
  do, with a `diff` snippet when code changes, and links its section below.
- One `##` per headline. One or two sentences, then a snippet of the
  user-facing API. Show DX, not implementation: what you write, what you get,
  the before/after error or output. Take snippets from the PR bodies, trim
  them, and check the names against the source (`grep` the export) since PRs
  get renamed in review.
- End a section with `Docs: [Page](/path)` links when a page covers it.
- Cite PRs inline as `([#NNN](https://github.com/alchemy-run/alchemy/pull/NNN))`.
- Credit external contributors by display name from `authors.txt`, linked to
  their GitHub profile: `Thanks [Name](https://github.com/login)!`. Use the
  login when there's no display name. PRs a maintainer opened on someone's
  behalf say so in the body ("carries #N by", "ported from", "supersedes");
  credit that person.
- End with `## Where to go next`: doc links, then
  `[CHANGELOG](https://github.com/alchemy-run/alchemy/blob/main/CHANGELOG.md#v200-betaNN)`
  and `[Compare v2.0.0-beta.N → v2.0.0-beta.N+1](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.N...v2.0.0-beta.N+1)`.

Style: plain, direct sentences; no marketing adjectives; no "X just
happened" lists explaining a snippet. Every ```diff block needs a context line
at column 0 (a comment, an import, the outer call), and `+`/`-` lines are the
marker followed by the line's real indentation. Inline code that contains a
backtick uses double-backtick delimiters.

## 5. Check it

```sh
python3 -I .agents/skills/release-blog/scripts/check-post.py website/src/content/docs/blog/<post>.md /tmp/release-blog-<next>
```

It checks that every docs link and anchor resolves and that every diff block
passes the website build's odd-indent check. Fix every problem it reports.
It also lists every `feat`, `fix`, `perf` or `!` PR the post doesn't cite.
Each one must be a deliberate skip (a fix-up of another PR in this release,
test or CI only); cite the rest.

Then hand the post to the user with the headline plan (sections and the PRs
behind each), the breaking-change list, and anything you weren't sure about:
a PR whose user impact was unclear, a section you cut, or the date. Don't
commit, push or open a PR unless asked.
