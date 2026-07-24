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

## How the test reproduces it

Small graphs stay single-chunk under Alchemy's default Worker bundler, so
`DrizzleSchemaChunks.test.ts`:

1. Builds with Alchemy's rolldown pipeline (`Bundle.build`, same defaults as
   `WorkerBundle`) while *forcing* the bad split via `output.codeSplitting`
   (not yet exposed on `Worker.build`)
2. Deploys the emitted multi-module graph with
   `Cloudflare.Worker({ bundle: false })` so Cloudflare's script-startup
   validation runs on the exact chunks

## The fix

`WorkerBundle` sets `strictExecutionOrder: true` on its rolldown output
options, which wraps cross-chunk modules so evaluation follows ESM semantics
regardless of how the graph was chunked. The test pins this: the identical
bad split deploys and serves once `strictExecutionOrder` is applied. The
user-side `advancedChunks` grouping workaround from the issue is also
covered but no longer necessary.
