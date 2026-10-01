---
name: alchemy-provider
description: Bring up a new Alchemy cloud provider (packages/alchemy/src/<Provider>) end to end — credentials, a distilled SDK, resources, bindings, live tests, and the patch loop that feeds live-test failures back into distilled — or extend an existing provider with a new service. Use for "add a <X> provider", "create an alchemy provider for <X>", "port <X> to alchemy", "add <service> to the <X> provider", or any work that needs a distilled SDK plus Alchemy resources tested against a live API.
---

# Building an Alchemy provider

A provider is built on a flywheel. Each turn of it makes both the SDK and
the provider more correct:

```
 1. distilled SDK ──> 2. alchemy resources ──> 3. live tests
        ^                                          │
        └──── 4. distilled patches <── wrong error / wrong schema
```

The live API is the only authority. A resource is done when its test
passes against the real provider, and every mismatch that test surfaced is
fixed in distilled rather than worked around in alchemy.

**The target is the whole provider.** "Create a provider for X" means every
resource in every service the distilled SDK covers is either implemented
and live-tested, or listed as out of scope with a reason from step 2. A
handful of foundation resources is the first wave, never the deliverable.
Cost is not a scoping reason: expensive resources are implemented like any
other (see step 6 for running their tests). The user narrows scope; the
agent does not.

`AGENTS.md` owns the doctrines this skill relies on; read these sections
before writing code and follow them as written:

- **Reconciler doctrine** — the observe → ensure → sync shape of `reconcile`.
- **Typed Error Doctrine (distilled)** — every error alchemy handles is a
  typed tag in the SDK.
- **Speed doctrine: never wait on a hang** — bounded retries, `timeout` on
  every test run, the three-iteration budget.
- **Read/Write/ReadWrite binding convention**, **Runtime-only methods**,
  and **Isolate scope vs request scope** — bindings and runtimes.
- **Documentation Generation** — JSDoc is the only docs source.
- **The Resource Factory Process** — how to fan the work out to agents.

Those rules existed while the GCP provider was built, and its first review
still found the same violations in hundreds of files. Reading the rules is
not enough: [review.md](review.md) turns each of them into a check with a
command and an expected result. Run that review at every wave boundary and
before step 10; a provider with unexplained hits is not done.

## Step 0 — get credentials first

**Always ask the user for credentials for the upstream provider before
anything else**, even when the request does not mention testing. Live tests
are the whole point of the loop, and a provider built without them is
unverified. Ask in one message, and name exactly what is needed:

- the auth method the provider supports (API token, service account key,
  OAuth app, access key pair) and the minimum scopes or roles the test
  resources need;
- a dedicated test account, project, or organization — never a production
  one, because tests create and nuke resources;
- account identifiers the API needs (org id, project id, default region);
- known limits of that account (plan tier, quotas, features that need an
  upgrade), so gated tests can be planned up front.

Store what the user gives you in an Alchemy profile, never in the repo:
`alchemy profile edit --profile testing --add <Provider>` (use the profile
name the user asks for). Tests select it with `--profile <name>`. Never
print a secret, write it to a tracked file, or put it in a PR, commit, or
log. If the user has no credentials, give them the exact steps to create
them (console path or CLI commands, roles to grant), offer to do it in the
browser if they allow it, and keep working on the catalog and code
meanwhile. Until credentials arrive, mark every live test as blocked in
your report; do not claim anything is tested.

## Step 1 — the distilled SDK

Every provider talks to its API through a distilled SDK
(`@distilled.cloud/<pkg>` in `submodules/distilled/packages/<pkg>`). Alchemy
never calls the API with a hand-written HTTP client.

- **No SDK yet:** follow the `distilled-sdk` skill in the submodule
  (`submodules/distilled/.agents/skills/distilled-sdk/SKILL.md`). It covers
  sourcing the spec, the mirror, convert/generate, the README, and the
  distilled PR.
- **SDK exists but is wrong** (missing typed error, nullable field, wrong
  response schema, unmarked secret): follow the `distilled-sdk-patch`
  skill (`submodules/distilled/.agents/skills/distilled-sdk-patch/SKILL.md`).
- **SDK is behind its spec:** follow `distilled-sdk-update`.

If a skill file is missing at the pinned submodule commit, read it from
distilled `main`: `git -C submodules/distilled fetch origin main && git -C
submodules/distilled show origin/main:.agents/skills/<skill>/SKILL.md`.

Distilled changes land as their own PR in `alchemy-run/distilled`. After
it merges, move the submodule pin in alchemy to the merged commit
(`git -C submodules/distilled checkout <sha>` then commit the gitlink) and
run `pnpm install` so the workspace links the package.

## Step 2 — catalog and scope

Catalog **every** service module in the SDK
(`ls submodules/distilled/packages/<pkg>/src/services`) before writing
resources; for a large SDK, fan the catalog out to research agents per
**The Resource Factory Process**. Each service gets
`processes/<Provider>/catalog/<service>.md` in that section's format:
resources, props with replacement rules, attributes,
lifecycle-to-operation mapping, bindings, testability, and priority.
`processes/` is gitignored, so the catalog is the local order book; the
committed record of scope is the overview page below.

`processes/<Provider>/catalog/INDEX.md` has one row per resource with a
status of `missing`, `implemented`, `tested`, `blocked` (with the exact
error), or `out-of-scope` (with the reason). Build waves from it and repeat
until no row is `missing` or `implemented`. Every progress report and the
final report quote its counts per status; "done" while any in-scope row is
`missing` is a false claim.

Decide scope per resource and record the out-of-scope list in the
provider's website overview under an "Out of scope" section:

- **In scope:** infrastructure the user configures and owns (databases,
  buckets, queues, networks, keys, functions, DNS).
- **Out of scope** (the only valid reasons): end-user data APIs (mail, calendar, documents, videos),
  APIs that need end-user OAuth scopes, deprecated or retired APIs,
  billing/subscription objects, closed-beta endpoints, and duplicates of
  another service.

Fix public names now; renaming after release is a breaking change.
Service namespaces are PascalCase (`AccessContextManager`), and resource
names are correct English singulars (`Index`, not `Indexe`; `Process`, not
`Processe`). Audit generated names by eye before the first PR.

## Step 3 — provider scaffolding

Copy the closest small provider. `packages/alchemy/src/Axiom` (token auth,
flat resources) and `packages/alchemy/src/Hetzner` (labels, `list`, nuke
ordering, bindings) are the templates. A provider directory holds:

| File | Purpose |
| --- | --- |
| `AuthProvider.ts` | `makeStoredAuthProvider` fields, CI env vars, `<Provider>Auth` layer |
| `Credentials.ts` | `fromAuthProvider()` → the distilled `Credentials` layer |
| `Providers.ts` | `ProviderCollection` + `providers()` layer (provider layers, credentials, `FetchHttpClient`, auth, profile and credential stores) |
| `index.ts` | re-exports every resource, binding, and layer |
| `Labels.ts` / tags helper | ownership labels, if the API supports labels or tags |

Register the provider everywhere the repo enumerates providers. Find the
full list by grepping for an existing provider (`git grep -n Axiom` and
`git grep -n Hetzner`, excluding its own directories); at the time of
writing it is:

- `packages/alchemy/package.json` — the `./<Provider>` export (both the
  `exports` and `publishConfig` blocks) and the `@distilled.cloud/<pkg>`
  dependency;
- `tsconfig.json` and `packages/alchemy/tsconfig.json` — project references
  to the distilled package;
- `.github/workflows/pkg.yml` — the distilled package group;
- `packages/alchemy/src/Alchemist/Session.ts` — `builtinAuth`;
- `packages/alchemy/src/Auth/Profile.ts` — `LEGACY_CREDENTIAL_KEYS` only if
  a legacy credential layout exists;
- `stacks/nuke.ts` — `<Provider>.providers()`;
- `scripts/with-fake-profiles.sh` — fake CI credentials;
- `website/astro.config.ts` and `website/src/content/docs/<provider>/`
  (`index.mdx`, `setup.mdx`) — sidebar, overview, and setup page.

Configuration such as region, project, or account comes from the
credential/profile or from a layer the user provides (the AWS
`AWS.Region(...)` pattern). Do not invent environment variables for it;
env vars exist only for CI credentials and for values the runtime platform
itself sets.

If `providers()` wires hundreds of resources, memoize it
(`let cached; export const providers = () => (cached ??= make())`) and keep
nested `Layer.mergeAll` groups of about 90; an unmemoized collection
rebuilds every layer per call and runs the test process out of memory.

## Step 4 — resources

Implement each resource per **Reconciler doctrine**, co-locating the
contract and provider in `src/<Provider>/<Service>/<Resource>.ts`. These
are the mistakes that most often slip through review (each has a check in
[review.md](review.md)):

- **Block until ready.** `reconcile` returns only after the API reports the
  resource usable: poll the long-running operation to completion and then
  read the ready state. Use one shared operation waiter per provider with a
  per-resource time budget that matches reality (minutes for databases and
  clusters). Post-ready propagation delay is acceptable; returning early is
  not.
- **Identity changes replace.** If a user-chosen name or id is part of the
  resource's identity, `diff` returns `replace` when it changes; otherwise
  the old resource leaks.
- **Missing is not forbidden.** Only a typed not-found tag means "gone".
  A permission error treated as not-found drops the row from state and
  leaks the resource. If the API returns 403 for missing resources, patch
  distilled with a specific tag for that case.
- **Lists fail loudly and paginate.** A `list` that swallows errors reports
  "nothing here" to nuke and hides leaks. Use the SDK's paginated
  `.items(...)` stream.
- **Ownership markers go in labels or tags.** When the API has neither,
  document the fallback marker in the resource JSDoc; never put markers in
  fields users see or that change behaviour.
- **Shared helpers live once per provider** (operation waiter, not-found
  helper, label diffing). Copies per service drift apart.
- **Implement `list`** filtered to Alchemy-owned resources, and declare
  `nuke: { dependsOn: [...] }` where delete order matters, so
  `alchemy unsafe nuke` can clean the test account.

## Step 5 — bindings and runtimes

Follow the binding sections of `AGENTS.md`. Grants are least privilege and
scoped to the bound resource (resource IAM policy, or a condition when the
API only grants at project level); document any unavoidable broader grant
in the binding's JSDoc. A provider that hosts code (functions, containers)
needs an Effect-native runtime and event sources that mirror the AWS and
Cloudflare shapes.

## Step 6 — live tests

Write tests per the test sections of `AGENTS.md` (`test.provider`,
`stack.destroy()` at start and end, deterministic names, out-of-band
verification through distilled, typed wait-until-gone). Run with the
profile from step 0:

```sh
timeout 240 pnpm test test/<Provider>/<Service>/<Resource>.test.ts --profile testing --retry 0
```

What a test must prove:

- **Every resource has its own test file**
  (`test/<Provider>/<Service>/<Resource>.test.ts`). Deploying a resource
  as a dependency inside another resource's test does not count, because
  its own update, replace, and delete paths never run.
- **Lifecycle runs by default.** Create, update, and (where applicable)
  replace against the real API. Slow lifecycles are gated behind one
  provider-wide flag with a realistic timeout; entitlement-bound ones keep
  an ungated probe that asserts the one specific typed tag the account
  returns.
- **Bindings run inside a deployed host** (a fixture Worker, Function, or
  container calling the binding over HTTP) so the IAM grant or native
  binding is exercised with the host's identity, not the deployer's.
- **Assertions can fail.** No always-true checks, no lists of acceptable
  tags, no early `return` that skips the assertions.

**Expensive resources** (dedicated clusters, large VMs or databases,
reserved capacity, anything billed per hour at a noticeable rate) are
implemented and get full tests, but you do not run those tests on your own.
Gate them behind the provider-wide slow flag, mark them `blocked: cost` in
the index, and list them for the user with an estimate of what one run
costs. Run them only after the user says so.

Scarce account quotas (networks, clusters, IP addresses) are shared with a
semaphore in a test helper, or moved to less-used regions. The suite still
runs in one process: `pnpm test test/<Provider> --profile testing`.

## Step 7 — framework websites

A provider that can run a web server or serve static files ships
`<Provider>.Website.<Framework>` composites, so a user deploys an Astro or
Next.js app with one call:

```ts
const site = yield* Hetzner.Website.Astro("Site", { rootDir: "./web" });
```

Ship the same framework set as the existing providers (`ls
packages/alchemy/src/Hetzner/Website` is the current list: Astro, Foldkit,
Nextjs, Nuxt, Octane, ReactRouter, SolidStart, StaticSite, SvelteKit,
TanStackStart, Vinext, Vite, Vocs, Waku). Copy the layout of
`src/Hetzner/Website/` or `src/Fly/Website/`:

- `FrameworkSite.ts` owns `makeFrameworkSite`, which builds through the
  framework integration (`@alchemy.run/frontend-frameworks/<framework>`)
  and deploys the build output onto the provider's compute. Its shared
  props (`rootDir`, `memo`, `dev`, `env`, `assets`, `domain`, `tags`) keep
  the names and meaning the sibling providers use.
- One small file per framework that only sets the framework specifier, the
  deploy target, and the framework's own option block.
- `StaticSite.ts` for assets-only sites, and `index.ts` exported from the
  provider barrel as `export * as Website from "./Website/index.ts"`.

The deploy target decides the work. Providers that run containers or VMs
use the Node target (`@alchemy.run/frontend-frameworks/<framework>/node`)
through the shared `src/Website/Server.ts`. A provider with its own
serverless runtime needs a new target per framework in
`packages/frontend-frameworks/src/<framework>/` next to `aws.ts`,
`cloudflare.ts`, and `neon.ts`.

Each framework gets a live `test/<Provider>/Website/<Framework>.test.ts`, a
`<Framework>.local.test.ts` for `alchemy dev`, and a shared
`PropSurface.test.ts`; an `examples/<provider>-website-<framework>`
example listed in `scripts/test-examples.ts`; and a page under
`website/src/content/docs/<provider>/frontend/`.

## Step 8 — close the loop

Every failure the live run exposes is classified before it is fixed, in
this order: **provider bug > distilled patch > test fix**.

| Symptom | Fix |
| --- | --- |
| `Unknown<Pkg>Error`, or a status/message you want to branch on | typed error patch (`distilled-sdk-patch`) |
| decode failure, field null or missing on the wire | nullable/optional patch |
| secret returned as a plain string | sensitive patch |
| resource leaks, returns before ready, wrong replace | provider fix in alchemy |
| test asserts something the API does not promise | test fix |

After a patch, regenerate only that package (`pnpm generate <pkg>` in the
submodule) and rerun the test immediately — the test runner reads distilled
from `src/`, so there is nothing to build. Collect the patches, prove each
with `pnpm patches:audit`, and ship them as a distilled PR, then bump the
pin (step 1).

After a full run, list what is still alive in the test account
(`pnpm nuke --dry-run --profile testing --include <Provider>.*` or the
provider's list calls). A green test that
leaves resources behind is a provider bug.

## Step 9 — review gate

Run every check in [review.md](review.md) with a fresh reviewer subagent
and fix what it finds. Report the result table to the user with the
counts, so they can see what was checked without re-reviewing by hand.

## Step 10 — docs, examples, and the PR

- JSDoc on every resource, prop, attribute, and binding, with `###`
  sections and `**Example:**` blocks; then `pnpm docs:check-jsdoc` and
  `pnpm docs:gen`.
- Examples under `examples/<provider>-*` that deploy and pass their own
  test, including at least one host with bindings.
- Type-check with `pnpm exec tsc -b` and format with `pnpm exec oxfmt`.
- Open the alchemy PR per **Pull Request Conventions**, linking the
  distilled PRs it depends on.

A draft PR for an early wave is fine; its description states the index
counts and that the provider is incomplete.

A provider is done when every SDK service is cataloged, every in-scope
resource has its own passing live test (or is `blocked: cost` and the user
has the list),
bindings follow the AWS/Cloudflare patterns and are least privilege, the
framework websites deploy, examples deploy, docs are generated, the review
gate is clean, the test account is clean after a full run, and every SDK
mismatch found along the way is a merged distilled patch.
