# Export tests

How `@alchemy.run/domain/Export` is tested, and how to run it. Everything runs on
`alchemy-test` from `packages/integration-tests`.

| Tier | Where | Runs | Needs |
| --- | --- | --- | --- |
| A | `test/Domain/Export*.test.ts` | every PR (`check.yml` runs `test/Domain`) | nothing: in-process stores and DuckDB |
| B | `test/DomainExport/*.test.ts` | the release run, step 4 | Docker |
| C | the same directory, tagged `export-lakes` | only when a run names the tag | Docker, about 3 GB of images |
| versions | the same directory, tagged `export-versions` | only when a run names the tag | Docker |
| live | `test/DomainExport/Live*.test.ts`, tagged `export-live` | only when a run names the tag **and** the provider's switch is set | an account, and money |

Every tier runs the same two suites, so an engine is held to one contract
wherever it runs: the store suite (`conformance.ts`) and the engine suite
(`engines.ts`). The engine suite's properties are: queries agree with the
model under the stable name through rebuilds and promotions; queries racing
the writer see only states the store passed through; every value an engine
binds (text a collation could fold, a quote a literal must escape, instants
from 1970 to 2100, every safe integer) selects what JavaScript's comparison
selects; a query asked of an empty table, asked again once rows arrive,
answers with them; and an instant a query returns is the instant written, to
the millisecond, as a `Date` or as ISO text with its zone (text without a
zone names no instant, so it fails).

| Suite | What it proves |
| --- | --- |
| `Export.test.ts` | A table hosted in a real model (`Story`, `InMemory`): one row per event and key with its metadata (an event a projection routes to two keys is two rows), history reaching a new table, reads shaped as Domain reads a view (`Filter`, `OrderBy`, paging, `atLeast`, lag), a lost write answer retried without a second row, definition errors, and the `sensitive` policy end to end (`omit` never stores the field; `encrypt` stores ciphertext and reads back with the `Sealer`). |
| `ExportProperties.test.ts` | Properties over generated inputs (`effect/Arbitrary`, fixed seeds): every event field becomes the columns its type says; columns and fingerprints do not depend on declaration order; lag is ingestion minus commit and a rebuild carries the first ingestion; a row reads back as the event written, sealed or not. |
| `ExportStoreMemory.test.ts`, `ExportStoreSqlite.test.ts` | The store suite: generated sequences of writes, retries, rebuilds and promotions, checked against a reference model on every read (`get`, paged `list`, `scan`, `lag`) under Domain filters and orderings. The data includes rows routed to two keys and the cases where SQL and JavaScript disagree: nulls under `NOT`, and strings that order differently by UTF-8 bytes and UTF-16 code units. |
| `ExportEngineConformance.test.ts` | The engine suite on DuckDB over the memory store, and on the SQL engine over SQLite (a libSQL file), which Bun's own SQLite then opens read-only and reads by the stable name. |
| `ExportEngine.test.ts` | Engines over a table a story fills, a stable name across a promotion, compile-time rejection of a table or column an engine's stores do not hold, and DuckDB with every optimizer on answering a query asked again from the table as it is now. |

Cases that drive a model use `Story` (`Story.make(Model, { layer })`): it
runs the model in memory, checks every commit, and leaves the lake for the
test to read. Three cases drive the model by hand instead, each saying why:
the reader tests (`Table.Reader` runs on the hosted model, whose receipts and
history a story keeps to itself), and the lost-answer retry (its delay sleeps
inside the table's handler, which a story settles under its own clock before
any step can move it). The store and engine suites involve no model.

All of `test/Domain` takes about 33 seconds of the PR job's 240.

## Tiers B, C and versions: Docker

Each file deploys its containers as Alchemy resources (`Docker.Network`,
`Docker.Container`, `Docker.Image`) on a scratch stack of its own, and
destroys them when it ends; a killed run's leftovers are drained by the next
run's leading destroy (`NO_DESTROY=1` keeps them for inspection). Each
published port is one the kernel hands out as free, bound to loopback.
Images are pinned by version and digest in `fixtures/docker.ts`, with the
reason beside any held version. Java servers run under CPU and memory limits.

A Docker file deploys its containers in a `beforeAll` (`exportSuite` in
`fixtures/docker.ts`), so deploying them, and on a cold machine pulling their
images (up to 2.4 GB for Trino), is setup, never a test's time. Every test's
ceiling is 120 seconds, and a readiness poll gives up after 90. Default run
counts keep each Docker file to a few minutes on a warm machine;
`EXPORT_TEST_RUNS` sets every property's run count for a deeper pass.

Each server's own client is an outside reader: run in the server's container
(`docker container exec`, through Alchemy's Docker service), it reads the
stable name after a retry, a rebuild and a promotion, and must print the
model's rows.

| Suite | Tier | What it proves |
| --- | --- | --- |
| `StorePostgres.test.ts`, `StoreMysql.test.ts`, `StoreClickhouse.test.ts` | B | The store and engine suites on `Export.Sql.store` and the SQL engine, on Postgres 17, MySQL 8.4 and ClickHouse 25.8 (`fixtures/sql.ts`); `psql`, `mysql` and `clickhouse-client` read the stable name. |
| `EngineTrinoPostgres.test.ts` | B | The engine suite on Trino 484's PostgreSQL connector over the Postgres store (`fixtures/trino.ts`); the `trino` CLI reads the stable name. The same suite runs `Export.Athena.engine` on this Trino, since Athena's engine (v3) is Trino: each query goes as Athena runs it (`EXECUTE IMMEDIATE '…' USING` with its execution parameters) and comes back as Athena returns it (every cell as text, each column's Trino type). The live tier runs it on Athena itself. |
| `StoreIceberg.test.ts` | B | `Export.Iceberg.store` on Apache's Iceberg REST fixture over MinIO: the store suite, the engine suite with DuckDB reading the attached catalog (each query resolves the promoted generation through the store's `stableName`), and the catalog's view under the stable name following each promotion, and back. |
| `EngineTrinoIceberg.test.ts` | B | The engine suite on Trino's Iceberg connector over the same lake; the `trino` CLI reads the catalog's view. |
| `StoreIceberg{Lakekeeper,Polaris,Nessie,Gravitino}.test.ts` | C | The Iceberg suites on each catalog. |
| `Consumers.test.ts` | C | Consumers written by hand (`consumers/`), each a server in an image built for it with every dependency fixed at build time (hash-locked Python wheels, DuckDB's extensions, checksummed Iceberg jars): a FastAPI service (PyIceberg scans with pushed-down filters), a data scientist's notebook in pandas, Polars and DuckDB Python, and a Spark SQL session reading the stable name, which must be the catalog's view. The Python readers resolve the live generation from the control tables as the view does (the latest `_export_promoted` row, else the first generation made), since none of them reads Iceberg views. Two properties over generated sequences: after every step, every answer is the model's; and with readers polling while the writer runs, every answer is the model's for some state the lake passed through during that read (each run must have reads that span a step, or it fails as never raced). |
| `StorePostgres{14,15,16}.test.ts`, `StoreMysql80.test.ts`, `StoreClickhouse253.test.ts`, `EngineTrino476Postgres.test.ts` | versions | The same suites on each older supported version: Postgres 14 to 16, MySQL 8.0, ClickHouse 25.3 LTS, Trino 476. |

`EXPORT_TEST_RUNS=<n>` sets every property's generated sequences, for a quick
pass (`3`) or a deep one.

## Live

A live file deploys its database through the provider's Alchemy resources,
runs the store and engine suites against it, and destroys it when the file
ends. It needs both the run naming `export-live` and the provider's own
switch; with either missing it spends nothing.

| Suite | Switch | Deploys |
| --- | --- | --- |
| `LivePlanetscaleMysql.test.ts` | `PLANETSCALE_TEST` | a PlanetScale MySQL (Vitess) database and an admin password; the client connects over TLS |
| `LivePlanetscalePostgres.test.ts` | `PLANETSCALE_TEST` | a PlanetScale Postgres database and a role |
| `LiveNeon.test.ts` | `NEON_TEST` | a Neon project |
| `LiveTurso.test.ts` | `TURSO_TEST` | a Turso group, database and token |
| `LiveAthena.test.ts` | `EXPORT_ATHENA_TEST` | an S3 bucket, a Glue database over it named from the stage, an Athena workgroup, and a Lambda with `AWS.Athena.Query` bound (`fixtures/athena-query.ts`). The Iceberg store writes through Glue's Iceberg REST endpoint; the Athena engine runs each query through the deployed binding, and DuckDB reads the same tables. The Lambda's URL runs any SQL it is sent, in that workgroup only, while the file's stack is deployed. Skipped against an emulator (`AWS_ENDPOINT_URL`). |

ClickHouse and Trino have no live suite: Alchemy has no provider for a
managed ClickHouse or Trino.

### What a live run costs

Computed 2026-11-11 from the providers' published prices (AWS us-east-1),
for one passing run of each file at its default run counts (lowered
2026-11-12 to fit the 120-second test ceiling), each database living about
15 to 30 minutes. Recompute when prices or run counts change.

| Suite | What bills | Per run |
| --- | --- | --- |
| `LivePlanetscalePostgres` | PS-10 HA (x86) at $39 a month, prorated to the millisecond ([Postgres pricing](https://planetscale.com/docs/postgres/pricing)) | about $0.03 to $0.05 |
| `LivePlanetscaleMysql` | Vitess PS-10 at $39 a month, its plan fee prorated when the database is deleted ([billing](https://planetscale.com/docs/billing)); the granularity is not published | about $0.05 if prorated by the hour, at most $1.28 if by the day |
| `LiveNeon` | the Free plan's 100 CU-hours per project; on Launch, $0.106 per CU-hour ([pricing](https://neon.com/pricing)) | $0 on Free, about $0.03 on Launch |
| `LiveTurso` | the Free plan's 10 million rows written and 500 million read a month ([pricing](https://turso.tech/pricing)) | $0 |
| `LiveAthena` | about 85 Athena queries, each billed at least 10 MB at $5 per TB scanned ([pricing](https://aws.amazon.com/athena/pricing/)), each through one Lambda invocation (within the free tier); Glue's first million requests a month free, then $1 per million; S3 requests for results and Iceberg files | about $0.02 |
| all five | | about $0.15, at most about $1.45 |

A failing property shrinks, which reruns its sequences (up to 20 times):
expect a few times the queries on a failing run, still cents. The cost to
watch is a database left behind: a run killed before its destroy keeps a
PS-10 billing (about $1.30 a day each) until the file runs again, whose
leading destroy removes it, or until it is deleted by hand.

## Iceberg catalogs

An Iceberg store keeps no SQL view: DuckDB cannot make Iceberg views and S3
Tables has none. Engines ask the store which generation each query reads
(`Export.Iceberg.names`). Where the REST catalog lists the view endpoints in
`/v1/config`, the store also keeps an Iceberg view under the stable name, with
Trino and Spark SQL, for queries written by hand. A promotion moves it in one
catalog commit (a new version, or an identical earlier one, made current), so
a reader never finds it missing. Engines do not depend on it; a failure to
update it is logged and the write stands. Trino reads a view only with its default
catalog, so a store whose readers include Trino names it: `Iceberg.store({
namespace, viewCatalog: "iceberg" })`, the name its readers give the catalog;
`EngineTrinoIceberg` reads the view that way, with no session catalog.

| Catalog | Status |
| --- | --- |
| Apache Iceberg REST fixture | tested, every release run (tier B) |
| Lakekeeper, Polaris, Nessie, Gravitino | tested when `export-lakes` runs (tier C) |
| Glue | live suite written (`LiveAthena`), not yet run |
| Any REST catalog (`Iceberg.Rest`, with `compatibility` flags) | generic |
| S3 Tables, BigLake, R2 Data Catalog | configured, not run live |
| Unity Catalog OSS | not tested: its local stack binds fixed host ports (8080, 9000) and needs an STS shim |

A catalog becomes "tested" only after a green run against it. Every tested
catalog runs with client-managed storage (DuckDB on the host uses MinIO's
keys), because vended credentials would carry addresses only the containers'
network resolves.

## DuckDB

Two DuckDB 1.5 behaviours shape `Export.DuckDb`, both found by these suites:

- A prepared statement run again after its table changed can answer from
  the statistics of when it was prepared: a grouped text column decodes to
  text no row holds. `Export.DuckDb` prepares every query afresh. The
  fixed case "asked again once rows arrive" holds it in every engine, and
  `ExportEngine`'s case with every optimizer on holds DuckDB's (where the
  `duckdb/plan-kept` mutant is killed: with the default settings below a
  kept plan answers correctly, so only that case can tell).
- With compressed materialization on, a grouped query racing a `MERGE` into
  the same table can return such text too (8 of 15 race runs; 0 of 15 with
  it off). `Export.DuckDb.layer` turns it off unless `config` sets
  `disabled_optimizers`.

## Instants

The instant case found two engines returning every instant shifted by the
machine's offset from UTC, both from clients parsing zone-less text in local
time. ClickHouse now answers the SQL engine in ISO with the zone
(`date_time_output_format = 'iso'`, merged into the caller's settings). A
MySQL `DATETIME` names no zone and the store writes UTC, so the engine probes
its client once and refuses to build unless it reads `DATETIME` as UTC
(`poolConfig: { timezone: "Z" }`); MySQL's suite holds both sides, with a
client pinned to `+05:00` so the case holds on a machine running in UTC too.

## The mutation gate

`DomainExport/mutation/mutants.ts` lists plausible bugs as small edits to the
real source of the stores and engines: a retry that overwrites, a rebuild
that forgets, a filter or order ignored, a cursor off by one, SQL's
three-valued logic leaking through `NOT`, a view left on the old generation,
a promotion that leaves the catalog's view behind, a collation that folds
case or trailing spaces, a literal left unquoted, a result's later pages
dropped, a plan kept across runs, an instant bound as the wrong type, a
table name resolved twice in one query. `pnpm test:export:mutants` runs, for
each, the suite named beside it in a process of its own, with
`mutate.preload.ts` applying the edit as Bun loads the file (the file on disk
never changes). A mutant passes only if it applied (its text occurs exactly
once; the preload records this) and a case of the suite then failed.

```sh
pnpm test:export:mutants --list              # the mutants and their suites
pnpm test:export:mutants                     # every mutant whose suite is tier A or B
pnpm test:export:mutants --lakes             # and those whose suite is tier C
pnpm test:export:mutants --only iceberg/     # by id prefix
```

A surviving mutant is a gap in a suite: strengthen the suite until it fails.
A mutant that cannot change behaviour does not belong in the list. A change
to a store's source can stop a mutant from applying; the gate then fails
until the mutant's text is updated.

ClickHouse keeps first-write-wins twice: a write skips identities already
held, and every read keeps the first row of each identity. Either alone
holds for one writer per key, so removing one cannot fail a test; the second
guards concurrent writers of one key, which these suites do not create. No
mutant targets them one at a time for that reason. Likewise an integer
column kept as `Float64`, or a `bigint` cell decoded as text, changes no
answer the suites can see (every safe integer survives both), so neither is
a mutant.

## Running

```sh
cd packages/integration-tests
bun alchemy-test test/Domain                                       # tier A, as the PR job runs it
bun alchemy-test test/DomainExport                                 # tier B (opt-in tiers skipped)
bun alchemy-test test/DomainExport --tags export-lakes             # tier C alone
bun alchemy-test test/DomainExport --tags export-versions          # older versions alone
bun alchemy-test test/DomainExport --tags 'local || export-lakes'  # tiers B and C
PLANETSCALE_TEST=1 bun alchemy-test test/DomainExport --tags export-live   # live, PlanetScale only
```

A property failure prints its shrunk input and a replay token; a conformance
failure names the read, the request, and both answers.
