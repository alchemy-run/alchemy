---
title: "A stage per pull request: deploy on open, destroy on close"
date: 2026-08-06
draft: true
excerpt: Open a PR and a bot comment appears with a live preview URL — Worker, Hyperdrive, a branch off the shared database, all real. Merge it and a cleanup job destroys the whole stage. Even the CI credentials were deployed as code — minted, scoped, and piped straight into GitHub's encrypted secrets.
---

<!-- VIDEO EMBED: a-stage-per-pull-request -->

A pull request opens. A minute later a bot comment appears
with a live preview URL. A second commit lands and the same
comment updates in place. The PR merges, a cleanup job goes
green, and the preview environment vanishes from every
console it touched.

Every event in that timeline was a program running — the
same type-checked stack you deploy to prod, pointed at a
stage named after the PR.

## The workflow

The whole lifecycle is one GitHub Actions file. This is the
workflow from [Tutorial Part 5](/cloudflare/tutorial/part-5),
verbatim:

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, reopened, synchronize, closed]

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

env:
  STAGE: >-
    ${{ github.event_name == 'pull_request'
      && format('pr-{0}', github.event.number)
      || (github.ref == 'refs/heads/main' && 'prod' || github.ref_name) }}

jobs:
  deploy:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - name: Deploy
        run: bun alchemy deploy --stage ${{ env.STAGE }} --yes
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PULL_REQUEST: ${{ github.event.number }}
          GITHUB_SHA: ${{ github.sha }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  cleanup:
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - name: Safety Check
        run: |
          if [ "${{ env.STAGE }}" = "prod" ]; then
            echo "ERROR: Cannot destroy prod environment in cleanup job"
            exit 1
          fi
      - name: Destroy Preview
        run: bun alchemy destroy --stage ${{ env.STAGE }} --yes
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PULL_REQUEST: ${{ github.event.number }}
```

Four things carry the whole story:

- **The stage comes from the event.** Pull requests compute
  `STAGE=pr-{number}`; pushes to `main` compute `prod`. A
  [stage](/environments/stages) is an isolated instance of the
  stack — its own state, its own physical names — so `pr-42`
  and `prod` can never collide.
- **Deploy runs on open and on every push.** The `deploy` job
  skips `closed` events and otherwise runs
  `alchemy deploy --stage pr-42` — the same command you'd type
  locally.
- **Destroy runs on close.** Merged or abandoned, the
  `cleanup` job runs `alchemy destroy --stage pr-42` and the
  stage's resources are removed.
- **Prod is guarded.** The safety check makes the cleanup job
  fail loudly if it ever computes `STAGE=prod`.

The [CI guide](/environments/ci) has the same workflow for
npm, pnpm, and yarn, plus the credential setup for AWS.

## Credentials are a stack too

The workflow reads `CLOUDFLARE_API_TOKEN` from the repo's
Actions secrets — and that secret is itself deployed as code.
A dedicated `stacks/github.ts` mints a scoped Cloudflare API
token and writes it into the repo:

```typescript
// stacks/github.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export default Alchemy.Stack(
  "github",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      GitHub.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");

    const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("CIToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Workers KV Storage Write",
            "Workers R2 Storage Write",
            "D1 Write",
            "Queues Write",
            "Pages Write",
            "Account Settings Write",
            "Secrets Store Write",
            "Workers Tail Read",
          ],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: "*",
          },
        },
      ],
    });

    yield* GitHub.Secret("cf-api-token", {
      owner: "your-org",
      repository: "your-repo",
      name: "CLOUDFLARE_API_TOKEN",
      value: apiToken.value,
    });

    yield* GitHub.Secret("cf-account-id", {
      owner: "your-org",
      repository: "your-repo",
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: Redacted.make(accountId),
    });
  }),
);
```

Deploy it once from your laptop, under an elevated
[profile](/environments/profiles):

```sh
alchemy deploy stacks/github.ts --profile admin
```

`AccountApiToken` calls `POST /accounts/{account_id}/tokens`,
and Cloudflare returns the freshly minted value exactly once.
Alchemy captures it, stores it in state, and pipes it straight
into `GitHub.Secret` — the token flows from Cloudflare's API
into GitHub's encrypted secrets inside one program, without
ever passing through a terminal or a CI log. The credential
set is reviewable, diffable, and reproducible: rotating the
token or trimming its permissions is an edit and a redeploy.

On AWS the same stack goes one step further: instead of a
stored secret, it provisions a GitHub OIDC provider and a
repo-scoped IAM role, then publishes the role ARN as an
Actions **variable**:

```typescript
yield* GitHub.Variable("aws-role-arn", {
  owner: "your-org",
  repository: "your-repo",
  name: "AWS_ROLE_ARN",
  value: role.roleArn,
});
```

The workflow assumes the role with `id-token: write` and
`aws-actions/configure-aws-credentials` — short-lived
credentials on every run. The full role definition, including
the `repo:your-org/your-repo:*` trust condition, is in the
[CI guide](/environments/ci#aws-with-github-oidc-recommended).

## A comment is a resource

The preview URL lands on the PR because the stack posts it —
`GitHub.Comment` is a resource like any other, deployed only
when CI passes a PR number:

```typescript
// alchemy.run.ts
if (process.env.PULL_REQUEST) {
  yield* GitHub.Comment("preview-comment", {
    owner: "your-org",
    repository: "your-repo",
    issueNumber: Number(process.env.PULL_REQUEST),
    body: Output.interpolate`
      ## Preview Deployed

      **URL:** ${worker.url}

      Built from commit ${process.env.GITHUB_SHA?.slice(0, 7)}

      ---
      _This comment updates automatically with each push._
    `,
  });
}
```

The logical ID `"preview-comment"` is stable across pushes, so
Alchemy reconciles the existing comment instead of posting a
new one. Ten commits, one comment — always showing the current
URL and SHA. `GITHUB_TOKEN` is provided by Actions
automatically and authorizes the write.

## The teardown

The cleanup job answers the question every preview-environment
setup gets asked: what happens to all those resources?

```sh
bun alchemy destroy --stage pr-42
```

Each stage keeps its own state — the persisted record of
everything the stage deployed. `destroy --stage pr-42` reads
that record and removes exactly those resources: the Worker,
the Hyperdrive config, the preview comment. And because the
data layer is
[a branch per PR off a shared database](/blog/2026-08-04-planetscale-branch-per-pr),
the stage's database branch goes with it — here in the
[Neon form](/cloudflare/data/branch-from-shared-database) of
the same conditional:

```typescript
const project = stage.startsWith("pr-")
  ? yield* Neon.Project.ref("app-db", { stage: "staging" })
  : yield* Neon.Project("app-db", {
      region: "aws-us-east-1",
    });
```

PR stages take the `ref` path: they *reference* the shared
project that `staging` owns and fork a copy-on-write branch
off it. On destroy, the branch is deleted and the referenced
project is left untouched — Alchemy doesn't own `app-db` from
this stage's perspective, so it can't delete it. The shared
database keeps serving `staging` and every other open PR.

Deploying or destroying one stage never touches another:

```sh
$ alchemy deploy --stage dev_sam     # -> myapp-dev_sam-photos-a3f1
$ alchemy deploy --stage pr-147     # -> myapp-pr_147-photos-9b2c
$ alchemy deploy --stage prod       # -> myapp-prod-photos-7d4e

$ alchemy destroy --stage pr-147    # only removes pr-147 resources
```

That's the full loop. One workflow file, one credentials
stack, one comment resource — and every pull request gets a
real, isolated copy of production that cleans up after itself.

## Where to go next

The same program has carried this whole series: a typed
Worker, tests that deploy and destroy real stacks, Durable
Objects and containers, a database branch per PR — and now a
lifecycle that runs it all from a pull request.

- [CI](/environments/ci) — the complete guide: the workflow,
  the GitHub stack, Cloudflare and AWS credential setups.
- [Stages](/environments/stages) — how `pr-42`, `dev_sam`, and
  `prod` stay isolated.
- [Tutorial Part 5: CI/CD](/cloudflare/tutorial/part-5) — the
  step-by-step walkthrough of everything above.
- [A database branch for every pull request](/blog/2026-08-04-planetscale-branch-per-pr)
  — the data layer each PR stage forks and destroys.

Alchemy is in beta:

```sh
bun add alchemy@next
```
