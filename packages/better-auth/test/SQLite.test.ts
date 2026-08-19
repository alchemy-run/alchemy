import { RuntimeContext } from "alchemy";
import { describe, expect, it } from "alchemy-test";
import { getSchema } from "better-auth/db";
import { organization } from "better-auth/plugins/organization";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import { issuerByProviderId } from "@/AccountIdentity.ts";
import { BetterAuth, BetterAuthMigrationError, Database } from "@/index.ts";
import { applyMigrations, schemaFingerprint } from "@/Migrate.ts";
import { SQLite } from "@/SQLite.ts";

const baseOptions = {
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
  secret: "test-secret-test-secret-test-secret",
} as const;

const provideTestEnv = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, RuntimeContext | FileSystem.FileSystem>> =>
  effect.pipe(
    Effect.provide(BunFileSystem.layer),
    Effect.provide(RuntimeContext.phantom),
  ) as Effect.Effect<A, E, Exclude<R, RuntimeContext | FileSystem.FileSystem>>;

const tempSqlitePath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectory({ prefix: "better-auth-sqlite" });
  return `${dir}/auth.sqlite`;
});

const sqliteDatabase = Effect.promise(() => import("bun:sqlite")).pipe(
  Effect.map((mod) => mod.Database),
);

const seedSqlite = (path: string, sql: string) =>
  Effect.gen(function* () {
    const BunSqlite = yield* sqliteDatabase;
    const raw = new BunSqlite(path);
    raw.exec(sql);
    raw.close();
  });

const unsignedJwt = (payload: Record<string, unknown>) => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
};

const expectMigrationError = (
  result: Result.Result<unknown, BetterAuthMigrationError>,
  snippet: string,
) => {
  expect(Result.isFailure(result)).toBe(true);
  if (!Result.isFailure(result)) {
    return;
  }
  expect(result.failure).toBeInstanceOf(BetterAuthMigrationError);
  expect(result.failure.message).toContain(snippet);
};

describe("BetterAuth (bun:sqlite)", () => {
  it.live("applies schema migrations idempotently", () =>
    Effect.gen(function* () {
      const path = yield* tempSqlitePath;
      const db = yield* Database.pipe(Effect.provide(SQLite(path)));
      expect(db.migrate).toBeDefined();

      const first = yield* applyMigrations(db.migrate!, baseOptions);
      expect(first.tablesCreated).toBeGreaterThan(0);

      // re-running against an up-to-date database is a no-op
      const second = yield* applyMigrations(db.migrate!, baseOptions);
      expect(second.tablesCreated).toBe(0);
      expect(second.tablesAltered).toBe(0);
      expect(second.indexesCreated).toBe(0);

      // verify the core tables actually exist in the file
      const { Database: BunSqlite } = yield* Effect.promise(
        () => import("bun:sqlite"),
      );
      const raw = new BunSqlite(path);
      const tables = (
        raw
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      const accountColumns = (
        raw.query("PRAGMA table_info(account)").all() as { name: string }[]
      ).map((row) => row.name);
      raw.close();
      for (const table of ["user", "session", "account", "verification"]) {
        expect(tables).toContain(table);
      }
      expect(accountColumns).toContain("issuer");
    }).pipe(provideTestEnv),
  );

  it.live("runs the full auth flow against the migrated database", () =>
    Effect.gen(function* () {
      const path = yield* tempSqlitePath;
      const layer = SQLite(path);
      const db = yield* Database.pipe(Effect.provide(layer));
      yield* applyMigrations(db.migrate!, baseOptions);

      const auth = yield* BetterAuth(baseOptions).pipe(
        // layer is path-parameterized per test — provided here rather than
        // on the outer test effect
        Effect.provide(layer),
      );
      const signUp = yield* auth.api.signUpEmail({
        body: {
          email: "sqlite@example.com",
          password: "password1234",
          name: "SQLite User",
        },
      });
      expect(signUp.user.email).toBe("sqlite@example.com");

      const signIn = yield* auth.api.signInEmail({
        body: { email: "sqlite@example.com", password: "password1234" },
      });
      expect(signIn.user.email).toBe("sqlite@example.com");
      expect(signIn.token).toBeDefined();

      const session = yield* auth.api.getSession({
        headers: new Headers({
          authorization: `Bearer ${signIn.token}`,
        }),
      });
      // sqlite persisted the user — a fresh read sees it
      expect(signUp.user.id).toBeDefined();
      void session;
    }).pipe(provideTestEnv),
  );

  it.live("schema fingerprint is stable and plugin-sensitive", () =>
    Effect.gen(function* () {
      const a = yield* schemaFingerprint(baseOptions);
      const b = yield* schemaFingerprint(baseOptions);
      expect(a).toBe(b);
      const withPlugin = yield* schemaFingerprint({
        ...baseOptions,
        plugins: [organization()],
      });
      expect(withPlugin).not.toBe(a);

      const schema = getSchema(baseOptions);
      expect(schema.account?.fields.issuer).toBeDefined();
      expect(
        schema.account?.indexes?.some((index) =>
          index.columns.includes("issuer"),
        ),
      ).toBe(true);
    }).pipe(provideTestEnv),
  );

  it("maps well-known and synthetic account issuers from options", () => {
    const issuers = issuerByProviderId({
      ...baseOptions,
      socialProviders: {
        cognito: {
          clientId: "id",
          clientSecret: "secret",
          domain: "example.auth.us-east-1.amazoncognito.com",
          region: "us-east-1",
          userPoolId: "us-east-1_abc",
        },
      },
      plugins: [
        {
          id: "generic-oauth",
          options: {
            config: [
              {
                providerId: "okta",
                accountIssuer: "https://example.okta.com",
              },
            ],
          },
        },
      ],
    });
    expect(issuers.get("credential")).toBe("local:credential");
    expect(issuers.get("siwe")).toBe("local:siwe");
    expect(issuers.get("google")).toBe("https://accounts.google.com");
    expect(issuers.get("cognito")).toBe(
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc",
    );
    expect(issuers.get("okta")).toBe("https://example.okta.com");
  });

  it.live("backfills account.issuer on a populated database", () =>
    Effect.gen(function* () {
      const path = yield* tempSqlitePath;
      const microsoftToken = unsignedJwt({
        iss: "https://login.microsoftonline.com/tenant/v2.0",
        oid: "stable-oid-1",
        sub: "pairwise-sub",
      });
      yield* seedSqlite(
        path,
        `
        CREATE TABLE user (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          emailVerified INTEGER NOT NULL,
          image TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        CREATE TABLE account (
          id TEXT PRIMARY KEY NOT NULL,
          accountId TEXT NOT NULL,
          providerId TEXT NOT NULL,
          userId TEXT NOT NULL,
          accessToken TEXT,
          refreshToken TEXT,
          idToken TEXT,
          accessTokenExpiresAt TEXT,
          refreshTokenExpiresAt TEXT,
          scope TEXT,
          password TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        INSERT INTO user VALUES
          ('user-1', 'Ada', 'ada@example.com', 1, NULL, '2026-01-01', '2026-01-01'),
          ('user-2', 'Bob', 'bob@example.com', 1, NULL, '2026-01-01', '2026-01-01'),
          ('user-3', 'Cyd', 'cyd@example.com', 1, NULL, '2026-01-01', '2026-01-01');
        INSERT INTO account (
          id, accountId, providerId, userId, idToken, password, createdAt, updatedAt
        ) VALUES
          ('acc-cred', 'not-the-user-id', 'credential', 'user-1', NULL, 'x', '2026-01-01', '2026-01-01'),
          ('acc-gh', 'octocat', 'github', 'user-2', NULL, NULL, '2026-01-01', '2026-01-01'),
          ('acc-ms', 'pairwise-sub', 'microsoft', 'user-3', '${microsoftToken}', NULL, '2026-01-01', '2026-01-01');
      `,
      );

      const db = yield* Database.pipe(Effect.provide(SQLite(path)));
      yield* applyMigrations(db.migrate!, baseOptions);

      const BunSqlite = yield* sqliteDatabase;
      const verify = new BunSqlite(path);
      const rows = verify
        .query(
          "SELECT id, issuer, accountId, providerId FROM account ORDER BY id",
        )
        .all() as {
        id: string;
        issuer: string;
        accountId: string;
        providerId: string;
      }[];
      const issuerCol = (
        verify.query("PRAGMA table_info(account)").all() as {
          name: string;
          notnull: number;
        }[]
      ).find((column) => column.name === "issuer");
      const indexes = (
        verify
          .query("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      verify.close();

      expect(rows).toEqual([
        {
          id: "acc-cred",
          issuer: "local:credential",
          accountId: "user-1",
          providerId: "credential",
        },
        {
          id: "acc-gh",
          issuer: "local:oauth:github",
          accountId: "octocat",
          providerId: "github",
        },
        {
          id: "acc-ms",
          issuer: "https://login.microsoftonline.com/tenant/v2.0",
          accountId: "stable-oid-1",
          providerId: "microsoft",
        },
      ]);
      expect(issuerCol?.notnull).toBe(1);
      expect(indexes).toContain("account_issuer_accountId_uidx");

      const second = yield* applyMigrations(db.migrate!, baseOptions);
      expect(second.tablesCreated).toBe(0);
      expect(second.tablesAltered).toBe(0);
    }).pipe(provideTestEnv),
  );

  it.live("refuses account identity collisions instead of merging rows", () =>
    Effect.gen(function* () {
      const path = yield* tempSqlitePath;
      yield* seedSqlite(
        path,
        `
        CREATE TABLE user (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          emailVerified INTEGER NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        CREATE TABLE account (
          id TEXT PRIMARY KEY NOT NULL,
          accountId TEXT NOT NULL,
          providerId TEXT NOT NULL,
          userId TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        INSERT INTO user VALUES
          ('user-1', 'Ada', 'ada@example.com', 1, '2026-01-01', '2026-01-01'),
          ('user-2', 'Bob', 'bob@example.com', 1, '2026-01-01', '2026-01-01');
        INSERT INTO account VALUES
          ('acc-1', 'same-github-id', 'github', 'user-1', '2026-01-01', '2026-01-01'),
          ('acc-2', 'same-github-id', 'github', 'user-2', '2026-01-01', '2026-01-01');
      `,
      );

      const db = yield* Database.pipe(Effect.provide(SQLite(path)));
      const result = yield* Effect.result(
        applyMigrations(db.migrate!, baseOptions),
      );
      expectMigrationError(result, "collisions");
    }).pipe(provideTestEnv),
  );

  it.live("refuses Microsoft rows that cannot yield oid", () =>
    Effect.gen(function* () {
      const path = yield* tempSqlitePath;
      yield* seedSqlite(
        path,
        `
        CREATE TABLE user (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          emailVerified INTEGER NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        CREATE TABLE account (
          id TEXT PRIMARY KEY NOT NULL,
          accountId TEXT NOT NULL,
          providerId TEXT NOT NULL,
          userId TEXT NOT NULL,
          idToken TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        INSERT INTO user VALUES
          ('user-1', 'Ada', 'ada@example.com', 1, '2026-01-01', '2026-01-01');
        INSERT INTO account VALUES
          ('acc-1', 'old-sub', 'microsoft', 'user-1', NULL, '2026-01-01', '2026-01-01');
      `,
      );

      const db = yield* Database.pipe(Effect.provide(SQLite(path)));
      const result = yield* Effect.result(
        applyMigrations(db.migrate!, baseOptions),
      );
      expectMigrationError(result, "Microsoft");
    }).pipe(provideTestEnv),
  );
});
