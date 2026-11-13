/**
 * The engine suite on Trino, whose PostgreSQL connector reads what
 * `Export.Sql.store` writes to Postgres, views included, plus the `trino`
 * CLI reading the stable name. Both containers are deployed by the calling
 * file's stack, on one network. One call per Trino version.
 *
 * The same suite also runs `Export.Athena.engine` on this Trino: Athena's
 * engine (v3) is Trino, so its queries are answered here as Athena answers
 * them (see `athenaOnTrino`). The live suite runs it on Athena itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryResult, RunQueryRequest } from "@alchemy.run/aws/Athena";
import * as Docker from "@alchemy.run/docker";
import * as Export from "@alchemy.run/domain/Export";
import * as ExportAthena from "@alchemy.run/domain/Export/Athena";
import { expect } from "@alchemy.run/test";
import { PgClient } from "@effect/sql-pg";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { SqlClient } from "effect/sql/SqlClient";
import {
  EngineLake,
  engineConformance,
  outsideReader,
} from "../../Domain/export-conformance/engines.ts";
import {
  deployed,
  dockerShrinks,
  execIn,
  exportSuite,
  fixtureStack,
  images,
  publish,
  runsOr,
  testTimeout,
  trino,
  trinoQuery,
  waitFor,
} from "./docker.ts";
import { versionsTag } from "./sql.ts";

/** A cell as Athena sends it: text, whatever its type (`NULL` stays `null`). */
const cellText = (cell: unknown): string | null =>
  cell === null
    ? null
    : typeof cell === "string"
      ? cell
      : typeof cell === "object"
        ? JSON.stringify(cell)
        : String(cell);

/**
 * Athena's query call (`AWS.Athena.Query`'s), answered by Trino. Athena runs
 * a query with execution parameters as Trino's `EXECUTE IMMEDIATE '…' USING
 * …`, the parameters already SQL literals; the result comes back as Athena's
 * does: each column's Trino type, every cell as text, a `SELECT`'s first row
 * the column names.
 */
const athenaOnTrino = (url: string) => (request: RunQueryRequest) => {
  const text = request.QueryString ?? "";
  const parameters = request.ExecutionParameters ?? [];
  const statement =
    parameters.length === 0
      ? text
      : `EXECUTE IMMEDIATE '${text.replaceAll("'", "''")}' USING ${parameters.join(", ")}`;
  return trinoQuery(url, statement, {
    user: "export",
    catalog: "postgresql",
    schema: "public",
  }).pipe(
    Effect.map(({ columns, rows }): QueryResult => {
      const names = columns.map((column) => column.name);
      const values = rows.map((row) => row.map(cellText));
      return {
        queryExecutionId: "trino",
        state: "SUCCEEDED",
        stateChangeReason: undefined,
        columns: names,
        types: columns.map((column) => column.type),
        rows: [names, ...values.map((row) => row.map((cell) => cell ?? ""))],
        values,
      };
    }),
  );
};

export interface TrinoPostgresSuiteOptions {
  /** The test file (`import.meta.url`), which owns the stack. */
  readonly file: string;
  /** The Trino image, pinned by version and digest (`images` in `docker.ts`). */
  readonly image: string;
  readonly version: string;
  /** An older version: runs only when a run names `export-versions`. */
  readonly optIn?: boolean;
}

export const trinoPostgresSuite = ({ file, image, version, optIn }: TrinoPostgresSuiteOptions) => {
  let trinoUrl = "";
  let trinoContainer = "";
  const environment = Layer.unwrap(
    Effect.gen(function* () {
      // Trino's catalog files, removed once the containers reading them are gone.
      const catalogs = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "alchemy-test-export-trino-"))),
        (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      writeFileSync(
        join(catalogs, "postgresql.properties"),
        [
          "connector.name=postgresql",
          "connection-url=jdbc:postgresql://postgres:5432/postgres",
          "connection-user=postgres",
          "connection-password=export",
          "unsupported-type-handling=CONVERT_TO_VARCHAR",
        ].join("\n"),
      );
      const pgPublished = yield* publish(5432);
      const trinoPublished = yield* publish(8080);
      const { engine } = yield* deployed(
        fixtureStack(`TrinoPostgres${version}`, file),
        Effect.gen(function* () {
          const network = yield* Docker.Network("Net", {});
          yield* Docker.Container("Postgres", {
            image: images.postgres,
            environment: { POSTGRES_PASSWORD: "export" },
            ports: [pgPublished.mapping],
            networks: [{ name: network.name, aliases: ["postgres"] }],
            start: true,
            memory: "512m",
          });
          const engine = yield* Docker.Container("Trino", {
            image,
            volumes: [{ hostPath: catalogs, containerPath: "/etc/trino/catalog", readOnly: true }],
            ports: [trinoPublished.mapping],
            networks: [{ name: network.name }],
            start: true,
            cpus: 2,
            memory: "2g",
          });
          return { engine };
        }),
      );
      trinoContainer = engine.name;
      trinoUrl = `http://127.0.0.1:${trinoPublished.port}`;
      // Ready once a query that reads a catalog runs: `SELECT 1` answers on the coordinator
      // before a worker has registered, and the next query then fails with NO_NODES_AVAILABLE.
      yield* waitFor(
        "Trino",
        trino(trinoUrl, "SELECT count(*) FROM postgresql.information_schema.schemata").pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      );
      const client = Layer.orDie(
        PgClient.layer({
          url: Redacted.make(`postgres://postgres:export@127.0.0.1:${pgPublished.port}/postgres`),
        }),
      );
      yield* waitFor(
        "Postgres",
        Effect.flatMap(SqlClient, (sql) => sql`SELECT 1`).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
          Effect.provide(client),
        ),
      );
      return Layer.mergeAll(client, FetchHttpClient.layer);
    }),
  );
  const tags = { tags: ["local", "docker"], ...(optIn ? { optInTags: [versionsTag] } : {}) };
  exportSuite(
    environment,
    `Domain Export engine (Trino ${version} over the Postgres store)`,
    (it) => {
      const test = (
        name: string,
        effect: Effect.Effect<void, unknown, SqlClient | HttpClient.HttpClient>,
      ) => it.effect(name, () => effect, { timeout: testTimeout, ...tags });
      engineConformance<SqlClient | HttpClient.HttpClient>({
        test,
        dialect: "trino",
        layer: (analytics, name) =>
          analytics
            .toLayer(
              Export.Trino.engine({
                url: trinoUrl,
                user: "export",
                catalog: "postgresql",
                schema: "public",
                name,
              }),
            )
            .pipe(Layer.provideMerge(EngineLake.toLayer(Export.Sql.store()))),
        freshNames: true,
        kind: "local",
        runs: runsOr(15),
        maxShrinks: dockerShrinks,
      });
      engineConformance<SqlClient | HttpClient.HttpClient>({
        test: (name, effect) => test(`Athena's engine: ${name}`, effect),
        dialect: "athena",
        layer: (analytics, name) =>
          analytics
            .toLayer(ExportAthena.engine({ query: athenaOnTrino(trinoUrl), name }))
            .pipe(Layer.provideMerge(EngineLake.toLayer(Export.Sql.store()))),
        freshNames: true,
        kind: "local",
        runs: runsOr(15),
        maxShrinks: dockerShrinks,
      });
      test(
        "the engine's queries ran on Trino, against the Postgres store's tables",
        Effect.gen(function* () {
          // The engine names itself `alchemy-domain-export` on every query (`X-Trino-Source`).
          const finished = yield* trino(
            trinoUrl,
            "SELECT count(*) FROM system.runtime.queries WHERE source = 'alchemy-domain-export' AND state = 'FINISHED'",
          );
          expect(Number(finished[0]?.[0])).toBeGreaterThan(0);
          const tables = yield* trino(
            trinoUrl,
            "SHOW TABLES FROM postgresql.public LIKE 'ledger_%'",
          );
          expect(tables.length).toBeGreaterThan(0);
        }),
      );
      outsideReader({
        test,
        label: "trino",
        make: Export.Sql.store(),
        client: (name) =>
          execIn(trinoContainer, [
            "trino",
            "--output-format",
            "CSV_UNQUOTED",
            "--execute",
            `SELECT key, count(*) FROM postgresql.public."${name}" GROUP BY key ORDER BY key`,
          ]),
        kind: "local",
      });
    },
  );
};
