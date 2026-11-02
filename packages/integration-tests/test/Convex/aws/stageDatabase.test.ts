import {
  createStatements,
  dropStatements,
  isSafeIdentifier,
  readyQuery,
} from "@alchemy.run/convex/internal/stageDatabase";
import { expect, it as test } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

test("postgres quotes identifiers", async () => {
  const statements = await run(createStatements("postgres", "pr_42", "abc123"));
  expect(statements).toContainEqual(expect.stringContaining('"pr_42"'));
  expect(statements).toContainEqual(expect.stringContaining("CREATE DATABASE"));
});

test("postgres closes the database to other stages", async () => {
  const statements = await run(createStatements("postgres", "pr_42", "abc123"));
  expect(statements).toContain('REVOKE CONNECT ON DATABASE "pr_42" FROM PUBLIC');
});

test("mysql is safe to run twice", async () => {
  const statements = await run(createStatements("mysql", "pr_42", "abc123"));
  expect(
    statements.every((sql) => !sql.startsWith("CREATE") || sql.includes("IF NOT EXISTS")),
  ).toBe(true);
  expect(statements).toContainEqual(expect.stringContaining("`pr_42`"));
});

test("a name outside [a-z0-9_] fails, so SQL can't be injected", async () => {
  const error = await createStatements("postgres", `x"; DROP DATABASE y; --`, "abc123").pipe(
    Effect.flip,
    Effect.runPromise,
  );
  expect(error._tag).toBe("InvalidIdentifier");
});

test("a password that isn't hex fails without being repeated", async () => {
  const error = await createStatements("mysql", "pr_42", "it's-a-secret").pipe(
    Effect.flip,
    Effect.runPromise,
  );
  expect(error._tag).toBe("InvalidIdentifier");
  expect(error.message).not.toContain("secret");
});

test("names that hold system data are refused", () => {
  for (const name of ["mysql", "postgres", "sys", "rdsadmin", "information_schema", "template1"]) {
    expect(isSafeIdentifier(name)).toBe(false);
  }
  expect(isSafeIdentifier("my_app_pr_42")).toBe(true);
});

test("drop refuses a system name too", async () => {
  const error = await dropStatements("mysql", "mysql").pipe(Effect.flip, Effect.runPromise);
  expect(error._tag).toBe("InvalidIdentifier");
});

test("mysql drop includes the user", async () => {
  const statements = await run(dropStatements("mysql", "pr_42"));
  expect(statements).toContain("DROP DATABASE IF EXISTS `pr_42`");
  expect(statements).toContain("DROP USER IF EXISTS 'pr_42'@'%'");
});

test("postgres drop ends connections first", async () => {
  const statements = await run(dropStatements("postgres", "pr_42"));
  expect(statements[0]).toContain("pg_terminate_backend");
  expect(statements).toContain('DROP DATABASE IF EXISTS "pr_42"');
  expect(statements).toContain('DROP ROLE IF EXISTS "pr_42"');
});

test("readyQuery asks whether the database exists", async () => {
  expect(await run(readyQuery("postgres", "pr_42"))).toContain("pg_database");
  expect(await run(readyQuery("mysql", "pr_42"))).toContain("SCHEMATA");
});

test("mysql escapes the wildcard in a grant, so a stage can't reach a similar name", async () => {
  const statements = await run(createStatements("mysql", "app_pr_1", "abc123"));
  expect(statements).toContainEqual(expect.stringContaining("`app\\_pr\\_1`.*"));
});

test("an existing user gets the current password", async () => {
  const postgres = await run(createStatements("postgres", "pr_42", "abc123"));
  const mysql = await run(createStatements("mysql", "pr_42", "abc123"));
  expect(postgres).toContainEqual(expect.stringContaining(`ALTER ROLE "pr_42"`));
  expect(mysql).toContainEqual(expect.stringContaining("ALTER USER 'pr_42'@'%'"));
});
