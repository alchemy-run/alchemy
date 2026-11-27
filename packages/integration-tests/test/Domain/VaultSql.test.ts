/**
 * A Vault's keys in a SQL database, against a real Postgres in Docker that
 * the suite deploys.
 */
import * as Docker from "@alchemy.run/docker";
import * as Domain from "@alchemy.run/domain";
import { SqlKeyStore } from "@alchemy.run/domain/SqlKeyStore";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import { PgClient } from "@effect/sql-pg";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { SqlClient } from "effect/sql/SqlClient";
import { caseNames, runCases } from "./vault/cases.ts";

const testOptions = { providers: Docker.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "DomainVaultSql", import.meta.url);

// Distinct from the Cluster fixtures' host ports (18610 to 18640).
const PORT = 18650;
const URL = `postgres://postgres:vault@127.0.0.1:${PORT}/postgres`;

const Postgres = PgClient.layer({ url: Redacted.make(URL), maxConnections: 4 });

const passed = Object.fromEntries(caseNames.map((name) => [name, true]));

describe("Domain Vault on SQL", { tags: ["provider:docker", "local"] }, () => {
  beforeAll(
    Effect.gen(function* () {
      if (!process.env.NO_DESTROY) yield* stack.destroy();
      yield* stack.deploy(
        Effect.gen(function* () {
          const image = yield* Docker.RemoteImage("VaultPostgresImage", {
            name: "postgres",
            tag: "17-alpine",
            alwaysPull: false,
          });
          yield* Docker.Container("VaultPostgres", {
            image: image.imageRef,
            environment: { POSTGRES_PASSWORD: "vault" },
            ports: [{ external: PORT, internal: 5432 }],
            start: true,
          });
        }),
      );
      // Postgres takes a few seconds to accept connections after the container starts.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`SELECT 1`;
      }).pipe(
        Effect.provide(PgClient.layer({ url: Redacted.make(URL), maxConnections: 1 })),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
      );
    }),
    { timeout: 180_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 120_000 });

  test(
    "keys in Postgres, wrapped under a root key",
    Effect.gen(function* () {
      expect(yield* runCases("sql-root")).toEqual(passed);
      // One row per subject that still has a key, and no key in the clear.
      const sql = yield* SqlClient;
      const rows = yield* sql<{
        subject: string;
        key: string;
      }>`SELECT subject, key FROM vault_keys`;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.key.startsWith("r1."))).toBe(true);
      expect(rows.some((row) => row.subject === "sql-root/e")).toBe(false);
    }).pipe(
      Effect.provide(
        Domain.VaultLive.pipe(
          Layer.provide(
            Layer.merge(SqlKeyStore(), Domain.RootKeyWrap(Redacted.make("c3".repeat(32)))),
          ),
          Layer.provideMerge(Postgres),
        ),
      ),
    ),
    { timeout: 60_000 },
  );

  test(
    "keys in a table of another name, unwrapped",
    Effect.gen(function* () {
      expect(yield* runCases("sql-none")).toEqual(passed);
      const sql = yield* SqlClient;
      const rows = yield* sql<{ subject: string }>`SELECT subject FROM bank_keys`;
      expect(rows.length).toBeGreaterThan(0);
    }).pipe(
      Effect.provide(
        Domain.VaultLive.pipe(
          Layer.provide(Layer.merge(SqlKeyStore({ table: "bank_keys" }), Domain.NoKeyWrap)),
          Layer.provideMerge(Postgres),
        ),
      ),
    ),
    { timeout: 60_000 },
  );
});
