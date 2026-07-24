# drizzle-schema-chunks

Fixture for [#749](https://github.com/alchemy-run/alchemy/issues/749).

Cloudflare Worker `ScriptStartupError` after Alchemy/Rolldown bundling when
top-level Drizzle schema modules are code-split into a chunk separate from
`drizzle-orm`. Cross-chunk evaluation in workerd leaves class bindings
incomplete (`PgSerialBuilder is not a constructor`, or the classic
`Cannot access '<minified>' before initialization` TDZ).

## Layout

Mirrors the reporter's monorepo shape:

- `schema/*` — db package tables (`pgTable` at module scope)
- `auth/*` — auth package tables that cross-import the db schema
- `worker.ts` — Worker entry that imports the full graph

## How the test pins the fix

Small graphs stay single-chunk under Alchemy's default Worker bundler, so
`DrizzleSchemaChunks.test.ts` deploys a stack whose `Cloudflare.Worker`
*forces* the issue's chunk layout via `build.output.codeSplitting` groups —
schema modules in a standalone `auth-*` chunk, `drizzle-orm` in its own
chunk. Cloudflare's script-startup validation runs on exactly those chunks
at upload, so the deploy itself is the regression assertion; the test then
verifies the chunk layout on disk and fetches the worker.

## The fix

`WorkerBundle` sets `strictExecutionOrder: true` on its rolldown output
options, which wraps cross-chunk modules so evaluation follows ESM semantics
regardless of how the graph was chunked. Before that default, this exact
split failed Cloudflare startup validation. The user-side `advancedChunks`
grouping workaround from the issue is no longer necessary.
