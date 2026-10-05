# Provider review gate

Each row turns a rule from `AGENTS.md` or the skill into a check with a
command and an expected result. The rows come from the first review of the
GCP provider and the corrections made during it; on the pre-fix GCP code
these greps returned hundreds of hits each.

Run it at every wave boundary and before calling a provider done. Use a
fresh reviewer (a subagent with no stake in the code) and have it report,
for every item, the command it ran, the count, and the file:line of each
hit it did not accept. "Looks fine" is not an answer. Every accepted hit
needs a one-line reason.

`<P>` is the provider directory (`packages/alchemy/src/<P>`,
`packages/alchemy/test/<P>`). The greps find candidates; read each hit.

## 0. Coverage

Run this first; the other sections only judge the code that exists.

| Check | Command | Expect |
| --- | --- | --- |
| Every service cataloged | compare `ls submodules/distilled/packages/<pkg>/src/services` with `ls processes/<P>/catalog` | one catalog file per service |
| Nothing left unbuilt | count statuses in `processes/<P>/catalog/INDEX.md` | no `missing` or `implemented` rows; every `out-of-scope` and `blocked` row has a reason or exact error |
| Index matches the code | every `tested` row has a `Resource<...>("<P>.<Service>.<Name>")` in `src/<P>` and a registered provider in `Providers.ts` | yes |
| One test file per resource | every `tested` row has `test/<P>/<Service>/<Name>.test.ts` | yes |
| Non-resource deliverables | index rows for bindings, runtime, event sources, websites, examples | none `missing`; `rg -l 'Binding.Service' src/<P>` is non-zero when the cloud has data-plane capabilities |
| Skill freshness | `git log -1 --format=%H -- .agents/skills/alchemy-provider` vs the `Skill: <sha>` line at the top of `INDEX.md` | equal; a newer skill commit means re-read it and add rows for its new deliverables |
| Docs generated for everything | `ls website/src/content/docs/providers/<P>` after `pnpm docs:gen` | one page per resource and binding page group, matching the index |
| Out-of-scope list published | the overview page's "Out of scope" section | matches the `out-of-scope` rows |

## How to compare against what good looks like

For each service, open the closest AWS or Cloudflare equivalent and compare
side by side: props naming, `diff`, `reconcile`, binding shape, test shape,
JSDoc examples. Where the new provider differs, the difference needs a
reason the platform forces. References:

| Concern | Reference |
| --- | --- |
| Small reconcile with labels, `list`, adoption | `src/Hetzner/SshKey.ts` |
| Multi-aspect reconcile | `src/AWS/DynamoDB/Table.ts`, `src/AWS/Kinesis/Stream.ts` |
| Read/Write/ReadWrite bindings, shared scaffolding unexported | `src/Cloudflare/R2/` |
| Bindings tested inside a deployed host | `test/AWS/DynamoDB/Bindings.test.ts` + `handler.ts` |
| Framework websites | `src/Hetzner/Website/`, `src/Fly/Website/` |

## 1. Effect code

| Check | Command | Expect |
| --- | --- | --- |
| Nested yields (`f(yield* x)`) | `rg -n 'yield\* [\w.]+\([^)]*yield\*' src/<P> test/<P> examples/<p>-*` | 0; bind to a named const first |
| `orDie` in lifecycle or binding init | `rg -n 'orDie' src/<P>` | only in credential and layer wiring (`Credentials.ts`, `Providers.ts`) |
| `Effect.promise` / swallowed causes | `rg -n 'Effect\.promise\|catchCause\|catchAllCause' src/<P>` | 0; use `Effect.tryPromise` with a typed error |
| Environment reads in resource code | `rg -n 'process\.env' src/<P>` | only `AuthProvider.ts` CI credentials |
| Widening casts | `rg -n 'as unknown as\|as any' src/<P>` | 0, or a comment naming the compiler limit |

## 2. Errors

| Check | Command | Expect |
| --- | --- | --- |
| Forbidden treated as missing | `rg -n '"Forbidden"' src/<P> test/<P>` | never in a not-found/gone path; a 403-for-missing API gets its own distilled tag |
| Message string matching | `rg -n 'message.*(includes\|match\|test)\(\|/[^/]*not found[^/]*/i' src/<P>` | 0; patch distilled with a matcher |
| Catch-all errors handled | `rg -n 'Unknown\w*Error\|HttpError' src/<P>` | 0 |
| Lists swallowing errors | `rg -n 'orElseSucceed\|catch\w*\(.*\[\]' src/<P>` | 0 on any list/read path |
| Single-page lists | read every `list` and `findBy*` helper | paginated (`.items(...)` or a page-token loop) |

## 3. Lifecycle

| Check | How | Expect |
| --- | --- | --- |
| One operation waiter | `rg -c 'waitFor\w*Operation\|pollOperation' src/<P>` | one definition in a shared module, many call sites |
| Realistic wait budgets | read each budget against the provider's documented create time | minutes for databases, clusters, environments; never a test-style 10 × 5s |
| Ready before return | read each `reconcile` | returns after the API reports ready, not after the create call |
| Identity change replaces | for each user-chosen name/id prop, read `diff` | `replace`; a rename test proves the old one is deleted |
| Ownership markers | `rg -n 'alchemy' src/<P> \| rg -v 'label\|tag\|import'` | markers only in labels/tags, never in user-visible fields |
| Copied helpers | `rg -c 'const (isNotFound\|isMissing\|ignoreMissing\|jsonEqual)' src/<P>` | one shared copy each |
| `output === undefined` branches | `rg -n 'output === undefined' src/<P>` | none inside `reconcile` |

## 4. Bindings and runtimes

| Check | How | Expect |
| --- | --- | --- |
| Least privilege | list every role/permission each binding grants (`rg -n 'roles/\|permission' src/<P>`) | scoped to the bound resource; no `admin`/`editor`/`owner` unless the JSDoc says why |
| Revocation | read the host's grant sync | revokes only grants Alchemy added; pre-existing grants survive |
| Secrets | read each binding that hands out a credential | `Redacted`, never a plain env var or log line |
| Argument shapes | type test | callables accept the resource, the Effect producing it, and the resolved value (`WriteTable(table)` and `WriteTable(yield* table)`) |
| Runtime coloring | read each runtime callable | requires `RuntimeContext`; no `WorkerEnvironment`-style leaks |
| Event sources | compare with AWS `SQS.QueueEventSource` / Cloudflare cron | contract in the source service, per-host implementation layers |
| User-facing config | read setup docs and examples | region/account from profile or a `<P>.Region("...")` layer, matching `AWS.Region`; no new env vars |

## 5. Tests

| Check | Command | Expect |
| --- | --- | --- |
| Gating flags | `rg -oh 'process\.env\.\w+' test/<P> \| sort \| uniq -c` | one provider-wide slow flag, entitlement flags, and ids of external systems a test needs; never sizes, regions, or other config as env vars |
| Lifecycle by default | `rg -c 'skipIf' test/<P>` against the file count | most lifecycles ungated |
| Accept-anything assertions | `rg -n 'expect\(\[' test/<P>` | each entitlement probe asserts one specific tag |
| Always-true assertions | `rg -n 'Array\.isArray\(.*\?\? \[\]\)\|toBeDefined\(\)' test/<P>` | each one asserts a real value |
| Early exits | `rg -n '^\s+return;$' test/<P>` | 0 |
| Bindings as the host | every `Bindings.test.ts` | deploys a fixture host and calls the binding over HTTP |
| Redeploy coverage | tests for anything that syncs grants or bindings on the host | deploy twice and assert the grant survives |
| Leaks | after a full run, list owned resources in the test account | none |
| Slow test cases | the runner's `✓`/`✗` result lines, which end with each test's duration (`pnpm test test/<P> ... \| rg '[✓✗]'`) | no failure-path case runs longer than a few minutes |
| Blocked rows | `rg -n 'blocked' processes/<P>/catalog/INDEX.md` | each needs payment, vendor approval, or hardware and names the exact request; quotas and preview features were requested through the API |
| Suite shape | how the suite was run | one process, whole provider directory; quotas shared with semaphores, never batched runs |

## 6. Docs, naming, and scope

| Check | Command | Expect |
| --- | --- | --- |
| Undeclared names in examples | `rg -n 'existing\.' src/<P>` and read every `**Example:**` | every identifier is declared in the example |
| Binding examples | count `@binding` blocks vs those showing the host and `Effect.provide(...)` | all of them |
| Resource examples | every `@resource` has at least one example | yes |
| Namespace casing | `ls src/<P>` | PascalCase |
| Singular names | read the list of exported resource names | correct English (`Index`, `Process`, `Batch`) |
| Scope | read the service list | no end-user data, OAuth-scoped, retired, or duplicate APIs; out-of-scope list on the overview page |
| Docs build | `pnpm docs:check-jsdoc && pnpm docs:gen` | clean |
