# @distilled.cloud/vendor-workers-shared

Private workspace package vendoring raw TypeScript source from
[`@cloudflare/workers-shared`](https://github.com/cloudflare/workers-sdk/tree/main/packages/workers-shared).
This package does not bundle or publish; consumer packages in this monorepo
import the `.ts` files directly and apply their own bundling.

Sibling vendored packages live alongside this one under `packages/`
(e.g. `packages/cloudflare-runtime/internal/workflows-shared` for `@cloudflare/workflows-shared`).

## Layout

The source tree is split into three buckets that correspond to three tsconfig
project references:

- `src/workers/` — code that runs in the Workers runtime. Typechecked against
  `@cloudflare/workers-types` only (plus `@cloudflare/vitest-pool-workers/types`
  for the colocated `tests/` directories).
- `src/shared/` — isomorphic code (web-platform APIs only) used by both Workers
  and Node consumers. Typechecked against the intersection of Workers and Node
  type sets.
- `src/node/` — Node-only code (build/config-time helpers that use `node:fs`,
  `node:path`, `process`, etc.). Typechecked against `@types/node` only.

`src/index.ts` is the Node-facing barrel (matching the upstream
`packages/workers-shared/index.ts`) and is typechecked under `tsconfig.node.json`.

## Provenance

Sourced from [`cloudflare/workers-sdk`](https://github.com/cloudflare/workers-sdk)
at commit `b973ed30015e4e4bface3c0733c33f624066523a` (path:
`packages/workers-shared`). Upstream license: MIT OR Apache-2.0.

| Upstream path                                                                                         | Vendored path                                      |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `asset-worker/`                                                                                       | `src/workers/asset-worker/`                        |
| `router-worker/`                                                                                      | `src/workers/router-worker/`                       |
| `utils/{constants,types,performance,responses,sentry,tracing}.ts`                                     | `src/shared/`                                      |
| `utils/configuration/{constants,parseHeaders,parseRedirects,parseStaticRouting,validateURL,types}.ts` | `src/shared/configuration/`                        |
| `utils/tests/parse*.test.ts`                                                                          | `src/shared/tests/`                                |
| `utils/helpers.ts`                                                                                    | `src/node/helpers.ts`                              |
| `utils/configuration/constructConfiguration.ts`                                                       | `src/node/configuration/constructConfiguration.ts` |
| `utils/tests/helpers.test.ts`                                                                         | `src/node/tests/helpers.test.ts`                   |
| `index.ts`                                                                                            | `src/index.ts` (rewritten paths)                   |

## Consumer imports

```ts
// Node-facing barrel (helpers + parsers + types + constants)
import { getContentType, parseHeaders } from "@distilled.cloud/vendor-workers-shared";

// Worker entries (default + named re-exports of ./src/worker)
import assetWorker from "@distilled.cloud/vendor-workers-shared/workers/asset-worker";
import routerWorker from "@distilled.cloud/vendor-workers-shared/workers/router-worker";

// Any individual module under the package via the wildcard
import { AssetConfig } from "@distilled.cloud/vendor-workers-shared/shared/types";
import { generateRulesMatcher } from "@distilled.cloud/vendor-workers-shared/workers/asset-worker/src/utils/rules-engine";
```
