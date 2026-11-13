/**
 * The Export suites over one SQL server in Docker: the store suite, the
 * engine suite (with its race and parameter properties), and the server's
 * own command-line client reading the stable name. One call per server and
 * version; the latest of each runs in the release run, the rest only when a
 * run names `export-versions`.
 */
import * as Docker from "@alchemy.run/docker";
import * as Export from "@alchemy.run/domain/Export";
import { expect } from "@alchemy.run/test";
import { ClickhouseClient } from "@effect/sql-clickhouse";
import { MysqlClient } from "@effect/sql-mysql2";
import { PgClient } from "@effect/sql-pg";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { SqlClient } from "effect/sql/SqlClient";
import { storeConformance } from "../../Domain/export-conformance/conformance.ts";
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
  publish,
  runsOr,
  testTimeout,
  waitFor,
} from "./docker.ts";

/** Older versions of each server: an opt-in tag, so a run that names nothing skips them. */
export const versionsTag = "export-versions";

export type Server = "postgres" | "mysql" | "clickhouse";

interface ServerShape {
  readonly label: string;
  readonly dialect: "postgres" | "mysql" | "clickhouse";
  readonly port: number;
  readonly environment: Record<string, string>;
  readonly limits: { readonly memory: string; readonly cpus?: number };
  /**
   * Generated sequences per property, unless `EXPORT_TEST_RUNS` says otherwise:
   * as many as fit the 120-second test ceiling with room to spare.
   */
  readonly runs: { readonly store: number; readonly engine: number };
  readonly client: (port: number) => Layer.Layer<SqlClient, unknown>;
  /** The server's own client, run in its container: rows per key over `stableName`, one line each. */
  readonly cli: (stableName: string) => ReadonlyArray<string>;
}

const servers: Record<Server, ServerShape> = {
  postgres: {
    label: "Postgres",
    dialect: "postgres",
    port: 5432,
    environment: { POSTGRES_PASSWORD: "export" },
    limits: { memory: "512m" },
    runs: { store: 60, engine: 40 },
    client: (port) =>
      PgClient.layer({
        url: Redacted.make(`postgres://postgres:export@127.0.0.1:${port}/postgres`),
      }),
    cli: (name) => [
      "psql",
      "-U",
      "postgres",
      "-At",
      "-F",
      ",",
      "-c",
      `SELECT key, count(*) FROM "${name}" GROUP BY key ORDER BY key`,
    ],
  },
  mysql: {
    label: "MySQL",
    dialect: "mysql",
    port: 3306,
    environment: { MYSQL_ROOT_PASSWORD: "export", MYSQL_DATABASE: "export" },
    limits: { memory: "1g" },
    runs: { store: 60, engine: 40 },
    client: (port) =>
      MysqlClient.layer({
        host: "127.0.0.1",
        port,
        database: "export",
        username: "root",
        password: Redacted.make("export"),
        // The store writes `DATETIME` in UTC; the engine requires a client that reads it so.
        poolConfig: { timezone: "Z" },
      }),
    cli: (name) => [
      "mysql",
      "-uroot",
      "-pexport",
      "-N",
      "-B",
      "export",
      "-e",
      `SELECT \`key\`, count(*) FROM \`${name}\` GROUP BY \`key\` ORDER BY \`key\``,
    ],
  },
  clickhouse: {
    label: "ClickHouse",
    dialect: "clickhouse",
    port: 8123,
    environment: { CLICKHOUSE_PASSWORD: "export" },
    limits: { memory: "2g", cpus: 2 },
    // The store suite reads every generation under every filter and ordering after each
    // sequence; on ClickHouse each read is a deduplicating subquery, about 4 seconds a sequence.
    runs: { store: 12, engine: 40 },
    client: (port) =>
      ClickhouseClient.layer({
        url: `http://127.0.0.1:${port}`,
        username: "default",
        password: "export",
      }),
    cli: (name) => [
      "clickhouse-client",
      "--password",
      "export",
      "--format",
      "CSV",
      "--query",
      `SELECT key, count() FROM ${name} GROUP BY key ORDER BY key`,
    ],
  },
};

export interface SqlServerSuiteOptions {
  /** The test file (`import.meta.url`), which owns the server's stack. */
  readonly file: string;
  readonly server: Server;
  /** The image, pinned by version and digest (`images` in `docker.ts`). */
  readonly image: string;
  /** The version, for the suite's name. */
  readonly version: string;
  /** An older version: runs only when a run names `export-versions`. */
  readonly optIn?: boolean;
}

export const sqlServerSuite = ({ file, server, image, version, optIn }: SqlServerSuiteOptions) => {
  const shape = servers[server];
  let container = "";
  let port = 0;
  // Ready once a client connects and a query answers: each image initialises, then restarts,
  // and the clients connect as they are built.
  const environment = Layer.unwrap(
    Effect.gen(function* () {
      const published = yield* publish(shape.port);
      const deployedServer = yield* deployed(
        fixtureStack(`${shape.label}${version.replaceAll(".", "_")}`, file),
        Docker.Container("Server", {
          image,
          environment: shape.environment,
          ports: [published.mapping],
          start: true,
          ...shape.limits,
        }),
      );
      container = deployedServer.name;
      port = published.port;
      const client = shape.client(published.port);
      yield* waitFor(
        shape.label,
        Effect.flatMap(SqlClient, (sql) => sql`SELECT 1`).pipe(
          Effect.provide(client),
          Effect.timeout("5 seconds"),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      );
      return Layer.orDie(client);
    }),
  );
  const tags = { tags: ["local", "docker"], ...(optIn ? { optInTags: [versionsTag] } : {}) };
  exportSuite(
    environment,
    `Domain Export SQL store and engine (${shape.label} ${version})`,
    (it) => {
      const test = (name: string, effect: Effect.Effect<void, unknown, SqlClient>) =>
        it.effect(name, () => effect, { timeout: testTimeout, ...tags });
      storeConformance({
        test,
        make: Export.Sql.store({ name: server }),
        kind: "local",
        runs: runsOr(shape.runs.store),
        maxShrinks: dockerShrinks,
      });
      engineConformance<SqlClient>({
        test,
        dialect: shape.dialect,
        layer: (analytics, name) =>
          analytics
            .toLayer(Export.Sql.engine({ name }))
            .pipe(Layer.provideMerge(EngineLake.toLayer(Export.Sql.store()))),
        freshNames: true,
        kind: "local",
        runs: runsOr(shape.runs.engine),
        maxShrinks: dockerShrinks,
      });
      outsideReader({
        test,
        label: shape.cli("")[0]!,
        make: Export.Sql.store(),
        client: (name) => execIn(container, shape.cli(name)),
        kind: "local",
      });
      if (server === "mysql")
        // A client's zone fixed, not the machine's: the case holds on a machine running in UTC too.
        test(
          "an engine refuses a client that reads DATETIME in a zone other than UTC",
          Effect.gen(function* () {
            const refused = yield* Export.Sql.engine().pipe(
              Effect.provide(
                Layer.orDie(
                  MysqlClient.layer({
                    host: "127.0.0.1",
                    port,
                    database: "export",
                    username: "root",
                    password: Redacted.make("export"),
                    poolConfig: { timezone: "+05:00" },
                  }),
                ),
              ),
              Effect.flip,
            );
            expect(refused.reason._tag).toBe("ClientTimeZone");
          }),
        );
    },
  );
};
