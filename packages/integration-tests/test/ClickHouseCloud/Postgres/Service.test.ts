import * as path from "node:path";
import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import pg from "pg";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { codeOf, messageOf } from "../fixtures/errors.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// A Postgres service bills compute while it runs (the smallest AWS size,
// a few minutes here). Opt in with CLICKHOUSE_CLOUD_TEST_SLOW=1.
const slow = !process.env.CLICKHOUSE_CLOUD_TEST_SLOW;

const migrations = path.join(import.meta.dirname, "fixtures", "migrations");

const declare = (props: {
  name: string;
  tags: Record<string, string>;
  password: string;
  deletionProtection?: boolean;
}) =>
  ClickHouseCloud.Postgres.Service("Db", {
    name: props.name,
    provider: "aws",
    region: "us-east-1",
    postgresVersion: "17",
    size: "r6gd.medium",
    tags: props.tags,
    password: Redacted.make(props.password),
    deletionProtection: props.deletionProtection,
    // Open to the test runner only for the few minutes the test runs.
    ipAccessList: [{ source: "0.0.0.0/0", portRange: "5432", description: "alchemy test" }],
    migrations,
  });

/** The tables in `public`, read over TLS with the service's CA. */
const tables = (db: ClickHouseCloud.Postgres.ServiceAttributes) =>
  Effect.tryPromise(async () => {
    // The URL carries sslmode=verify-full, which would override `ssl`, so
    // its parts are passed with the CA instead.
    const url = new URL(Redacted.value(db.connectionString!));
    const client = new pg.Client({
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1) || "postgres",
      ssl: { ca: db.caCertificates, rejectUnauthorized: true },
    });
    await client.connect();
    try {
      const { rows } = await client.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      );
      return rows.map((r) => r.tablename);
    } finally {
      await client.end();
    }
  }).pipe(
    // ClickHouse applies a new password a few seconds after the deploy,
    // and a renamed service's new host name takes a while to resolve and
    // to present a certificate for it.
    Effect.retry({
      while: (e) =>
        ["28P01", "ENOTFOUND", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(String(codeOf(e.cause))),
      schedule: Schedule.spaced("5 seconds"),
      times: 120,
    }),
    Effect.orDie,
  );

const exists = (postgresId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* postgres.getPostgresService({ organizationId, postgresId }).pipe(
      Effect.as(true),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
    );
  });

test.provider.skipIf(slow)(
  "create a Postgres service with migrations, retag it and change its password in place",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const name = `alchemy-test-${stack.stage.toLowerCase()}`.slice(0, 40);
      const db = yield* stack.deploy(
        declare({ name, tags: { purpose: "alchemy-test" }, password: "first-Password-0001" }),
      );
      expect(db.state).toEqual("running");
      expect(db.size).toEqual("r6gd.medium");
      expect(db.tags.purpose).toEqual("alchemy-test");
      expect(Object.keys(db.migrationsHashes)).toEqual(["0001_notes.sql"]);
      expect(yield* tables(db)).toContain("notes");

      const updated = yield* stack.deploy(
        declare({
          name,
          tags: { purpose: "alchemy-test", round: "2" },
          password: "second-Password-0002",
        }),
      );
      expect(updated.postgresId).toEqual(db.postgresId);
      expect(updated.name).toEqual(name);
      expect(updated.tags.round).toEqual("2");
      expect(Redacted.value(updated.passwordDigest!)).not.toEqual(
        Redacted.value(db.passwordDigest!),
      );
      // The new password works (ClickHouse applies it within seconds).
      expect(yield* tables(updated)).toContain("notes");

      // Deletion protection is an organization-level entitlement.
      const refused = yield* stack
        .deploy(
          declare({
            name,
            tags: { purpose: "alchemy-test", round: "2" },
            password: "second-Password-0002",
            deletionProtection: true,
          }),
        )
        .pipe(Effect.flip);
      expect(refused._tag).toEqual("DeletionProtectionNotEnabled");
      expect(messageOf(refused)).toEqual(
        "BAD_REQUEST: Deletion protection is not enabled for this organization.",
      );

      yield* stack.destroy();
      const gone = yield* exists(db.postgresId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("15 seconds").pipe(Schedule.upTo({ duration: "10 minutes" })),
          until: (present) => !present,
        }),
      );
      expect(gone).toBe(false);
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 3_600_000 },
);
