import * as Docker from "@alchemy.run/docker";
import { makePostgresState } from "@alchemy.run/sql/PostgresState";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { exec } from "alchemy/Util/exec";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  current,
  deployArgs,
  fails,
  planLine,
  released,
  RELEASED,
  succeeds,
  workdir,
  type RunOptions,
} from "./Harness.ts";
import {
  expectPlaintext,
  expectSealedJson,
  secretsOfTexts,
  secretsThroughStore,
  STACK,
} from "./Records.ts";

const { test } = Test.make({ providers: Docker.providers() });

const PASSWORD = "state-upgrade";

class PsqlError extends Data.TaggedError("PsqlError")<{ readonly message: string }> {}

/** Run SQL in the container with psql, one row per line. */
const psql = Effect.fn(function* (container: string, query: string) {
  const result = yield* exec(
    ChildProcess.make(
      "docker",
      ["exec", container, "psql", "-U", "postgres", "-d", "state", "-tA", "-c", query],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  if (result.exitCode !== 0) return yield* new PsqlError({ message: result.stderr });
  return result.stdout.split("\n").filter((line) => line !== "");
});

/** A stage's rows, records and output, as stored text, from the named column. */
const stageRows = Effect.fn(function* (container: string, column: "value" | "data") {
  const where = `stack = '${STACK}' and stage = 'one'`;
  const records = yield* psql(
    container,
    `select ${column}::text from alchemy_resource_state where ${where} order by fqn`,
  );
  const output = yield* psql(
    container,
    `select ${column}::text from alchemy_stack_output where ${where}`,
  );
  return [...records, ...output];
});

const columns = (container: string, table: string) =>
  psql(
    container,
    `select column_name from information_schema.columns where table_name = '${table}' order by column_name`,
  );

test.provider(
  `a Postgres store written by ${RELEASED} moves to the new schema without losing a row`,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const db = yield* stack.deploy(
        Docker.Container("Postgres", {
          image: "postgres:17-alpine",
          environment: { POSTGRES_PASSWORD: PASSWORD, POSTGRES_DB: "state" },
          ports: [{ external: 0, internal: 5432 }],
          start: true,
        }),
      );
      // The image restarts the server once while it initializes the database.
      yield* psql(db.name, "select 1").pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
      );
      const url = `postgres://postgres:${PASSWORD}@127.0.0.1:${db.ports["5432/tcp"]}/state`;

      const cwd = yield* workdir("postgres");
      const old = yield* released();
      const next = yield* current();
      const on = (overrides: Record<string, string> = {}): RunOptions => ({
        cwd,
        env: { UPGRADE_STORE: "postgres", UPGRADE_PG_URL: url, ...overrides },
      });

      yield* succeeds(old, deployArgs("one"), on());
      expect(yield* columns(db.name, "alchemy_resource_state")).toContain("value");
      const original = yield* stageRows(db.name, "value");
      expect(original).toHaveLength(3);
      const secrets = secretsOfTexts(original);

      // The new version renames the column and records the store's format,
      // keeping every row as it was.
      const upgraded = yield* succeeds(next, deployArgs("one"), on());
      expect(planLine(upgraded)).toBe("Plan: no changes");
      for (const table of ["alchemy_resource_state", "alchemy_stack_output"]) {
        const names = yield* columns(db.name, table);
        expect(names).toContain("data");
        expect(names).not.toContain("value");
      }
      expect(yield* psql(db.name, "select format from alchemy_state_store")).toEqual(["1"]);
      expect(yield* stageRows(db.name, "data")).toEqual(original);

      // The released version can't query the renamed column, so it can
      // never deploy from state it would misread. It only reports the query
      // failing: `column "value" does not exist` is in its log.
      const refused = yield* fails(old, deployArgs("one"), on());
      expect(refused.output).toContain("PgConnection: Query failed");
      expect(yield* stageRows(db.name, "data")).toEqual(original);

      // Encrypting with a layer seals the rows, and `disable` opens them again.
      const passphrase = { ALCHEMY_STATE_PASSPHRASE: "state upgrade test passphrase" };
      yield* succeeds(
        next,
        deployArgs("one"),
        on({ ...passphrase, UPGRADE_ENCRYPTION: "passphrase" }),
      );
      const sealed = yield* stageRows(db.name, "data");
      expect(sealed).toHaveLength(3);
      expectSealedJson(sealed, secrets);
      yield* succeeds(
        next,
        deployArgs("one"),
        on({ ...passphrase, UPGRADE_ENCRYPTION: "passphrase-disable" }),
      );
      const decrypted = yield* stageRows(db.name, "data");
      expectPlaintext(decrypted);
      expect(secretsOfTexts(decrypted)).toEqual(secrets);

      const open = Effect.scope.pipe(
        Effect.flatMap((scope) => makePostgresState({ url: Redacted.make(url) }, scope)),
      );
      expect(yield* secretsThroughStore(open, "one")).toEqual(secrets);

      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "provider:sql", "local"], timeout: 300_000 },
);
