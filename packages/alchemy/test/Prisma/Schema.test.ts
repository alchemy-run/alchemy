import * as Prisma from "@/Prisma";
import * as Provider from "@/Provider";
import * as Stack from "@/Stack";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const { test } = Test.make({ providers: Prisma.providers() });

const SCHEMA_SOURCE = `
datasource db {
  provider = "postgresql"
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`;

const DRIFTED_SCHEMA_SOURCE =
  SCHEMA_SOURCE +
  `
model Post {
  id    Int    @id @default(autoincrement())
  title String
}
`;

const SQLITE_SCHEMA_SOURCE = `
datasource db {
  provider = "sqlite"
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`;

const GENERATOR_SCHEMA_SOURCE = `
generator client {
  provider = "prisma-client"
  output   = "./generated"
}
${SQLITE_SCHEMA_SOURCE}`;

const stageWorkspace = (initialSource: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({
      prefix: "alchemy-prisma-schema-test-",
    });
    const schemaPath = path.join(root, "schema.prisma");
    yield* fs.writeFileString(schemaPath, initialSource);
    const out = path.join(root, "migrations");
    return { root, out, schemaPath };
  });

const readMigrationDirs = (out: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.readDirectory(out))
      .filter((name) => /^\d+_/.test(name))
      .sort();
  });

const readMigrationSql = (out: string, dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(out, dir, "migration.sql"));
  });

const getStatus = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack.Stack;
  const s = yield* state.get({ stack: stk.name, stage: stk.stage, fqn });
  return s?.status;
});

test.provider(
  "initial deploy generates a migration, snapshot, and lock file",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      const schema = yield* stack.deploy(
        Prisma.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );

      const dirs = yield* readMigrationDirs(ws.out);
      expect(dirs).toHaveLength(1);
      expect(schema.migrations).toEqual(dirs);

      const sql = yield* readMigrationSql(ws.out, dirs[0]!);
      expect(sql).toContain(`CREATE TABLE "User"`);

      const snapshot = yield* fs.readFileString(
        path.join(ws.out, dirs[0]!, "snapshot.prisma"),
      );
      expect(snapshot).toEqual(SCHEMA_SOURCE);

      const lock = yield* fs.readFileString(
        path.join(ws.out, "migration_lock.toml"),
      );
      expect(lock).toContain(`provider = "postgresql"`);
    }),
);

test.provider(
  "repeated deploys with no schema drift produce noop, not update",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      yield* stack.deploy(
        Prisma.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );
      expect(yield* getStatus("app-schema")).toEqual("created");

      // Second deploy with the same schema. If Schema.diff returned
      // `{ action: "update" }` unconditionally, status would flip to
      // "updated" and downstream resources (e.g. Neon.Branch) would see
      // `schema.out` as an unresolved Output during plan and cascade into
      // their own spurious updates.
      yield* stack.deploy(
        Prisma.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );
      expect(yield* getStatus("app-schema")).toEqual("created");
      expect(yield* readMigrationDirs(ws.out)).toHaveLength(1);
    }),
);

test.provider(
  "deploy after a real schema change appends a delta migration",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      const initial = yield* stack.deploy(
        Prisma.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );

      yield* fs.writeFileString(ws.schemaPath, DRIFTED_SCHEMA_SOURCE);
      // Migration directory names are second-resolution timestamps; make
      // sure the delta migration gets its own directory.
      yield* Effect.sleep("1 second");

      const drifted = yield* stack.deploy(
        Prisma.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );

      expect(yield* getStatus("app-schema")).toEqual("updated");
      expect(drifted.snapshotHash).not.toEqual(initial.snapshotHash);

      const dirs = yield* readMigrationDirs(ws.out);
      expect(dirs).toHaveLength(2);

      // The second migration is a delta against the snapshot, not a full
      // re-create of the whole schema.
      const sql = yield* readMigrationSql(ws.out, dirs[1]!);
      expect(sql).toContain(`CREATE TABLE "Post"`);
      expect(sql).not.toContain(`CREATE TABLE "User"`);
    }),
);

test.provider(
  "adopting an existing prisma-migrate project records a baseline instead of re-emitting SQL",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      // Simulate a project whose migrations were created by
      // `prisma migrate dev`: a migration.sql exists but no snapshot.
      const existing = path.join(ws.out, "20240101000000_init");
      yield* fs.makeDirectory(existing, { recursive: true });
      yield* fs.writeFileString(
        path.join(existing, "migration.sql"),
        `CREATE TABLE "User" ("id" SERIAL PRIMARY KEY, "email" TEXT NOT NULL);`,
      );

      yield* stack.deploy(
        Prisma.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );

      // No new migration directory — the existing migrations are assumed to
      // already express the current schema.
      const dirs = yield* readMigrationDirs(ws.out);
      expect(dirs).toEqual(["20240101000000_init"]);

      // ...but the baseline snapshot is now recorded, so the next drift
      // diffs against it.
      const snapshot = yield* fs.readFileString(
        path.join(existing, "snapshot.prisma"),
      );
      expect(snapshot).toEqual(SCHEMA_SOURCE);

      yield* fs.writeFileString(ws.schemaPath, DRIFTED_SCHEMA_SOURCE);
      yield* stack.deploy(
        Prisma.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );

      const after = yield* readMigrationDirs(ws.out);
      expect(after).toHaveLength(2);
      const sql = yield* readMigrationSql(
        ws.out,
        after.find((d) => d !== "20240101000000_init")!,
      );
      expect(sql).toContain(`CREATE TABLE "Post"`);
      expect(sql).not.toContain(`CREATE TABLE "User"`);
    }),
);

test.provider("sqlite schemas generate D1-compatible migrations", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ws = yield* stageWorkspace(SQLITE_SCHEMA_SOURCE);

    yield* stack.deploy(
      Prisma.Schema("sqlite-schema", {
        schema: ws.schemaPath,
        out: ws.out,
      }),
    );

    const dirs = yield* readMigrationDirs(ws.out);
    expect(dirs).toHaveLength(1);
    const sql = yield* readMigrationSql(ws.out, dirs[0]!);
    expect(sql).toContain(`CREATE TABLE "User"`);

    const lock = yield* fs.readFileString(
      path.join(ws.out, "migration_lock.toml"),
    );
    expect(lock).toContain(`provider = "sqlite"`);
  }),
);

test.provider(
  "generateClient runs prisma generate when the schema has a generator",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(GENERATOR_SCHEMA_SOURCE);

      yield* stack.deploy(
        Prisma.Schema("gen-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );

      // Output is resolved relative to the schema file.
      const generated = yield* fs.exists(path.join(ws.root, "generated"));
      expect(generated).toBe(true);
    }),
);

test.provider("list returns [] (non-listable local build artifact)", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(Prisma.Schema);
    const all = yield* provider.list();
    expect(all).toEqual([]);

    yield* stack.destroy();
  }),
);
