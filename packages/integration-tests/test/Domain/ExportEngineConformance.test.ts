import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Export from "@alchemy.run/domain/Export";
import * as ExportDuckDb from "@alchemy.run/domain/Export/DuckDb";
import { afterAll, beforeAll, describe, it } from "@alchemy.run/test";
import { LibsqlClient } from "@effect/sql-libsql";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlClient } from "effect/sql/SqlClient";
import { EngineLake, engineConformance, outsideReader } from "./export-conformance/engines.ts";

describe("Domain Export engine (DuckDB over the memory store)", { tags: ["unit", "local"] }, () => {
  engineConformance({
    test: (name, effect, options) => it.effect(name, () => effect, options),
    dialect: "duckdb",
    layer: (analytics) =>
      ExportDuckDb.memory(analytics).pipe(Layer.provideMerge(EngineLake.memory())),
    freshNames: false,
    kind: "local",
    // The memory store writes a step at once: no read can land inside it.
    readsInterleave: false,
  });
});

describe("Domain Export engine (SQLite over the SQL store)", { tags: ["unit", "local"] }, () => {
  /** One SQLite file for the suite, in a directory made when it starts and removed when it ends. */
  let directory = "";
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "export-engines-"));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const database = Layer.unwrap(
    Effect.sync(() => LibsqlClient.layer({ url: `file:${join(directory, "engines.db")}` })),
  );
  engineConformance<SqlClient>({
    test: (name, effect, options) =>
      it.effect(name, () => effect.pipe(Effect.provide(database)), options),
    dialect: "sqlite",
    layer: (analytics, name) =>
      analytics
        .toLayer(Export.Sql.engine({ name, stream: "collect" }))
        .pipe(Layer.provideMerge(EngineLake.toLayer(Export.Sql.store()))),
    freshNames: true,
    kind: "local",
    // One libSQL connection serialises the writer's statements and the readers'.
    readsInterleave: false,
  });
  // Another SQLite, Bun's own, opening the file read-only as a person's tool would.
  outsideReader<SqlClient>({
    test: (name, effect, options) =>
      it.effect(name, () => effect.pipe(Effect.provide(database)), options),
    label: "bun:sqlite",
    make: Export.Sql.store(),
    client: (name) =>
      Effect.sync(() => {
        const reader = new Database(join(directory, "engines.db"), { readonly: true });
        try {
          return reader
            .query<{ key: string; total: number }, []>(
              `SELECT key, count(*) AS total FROM "${name}" GROUP BY key ORDER BY key`,
            )
            .all()
            .map((row) => `${row.key},${row.total}`)
            .join("\n");
        } finally {
          reader.close();
        }
      }),
    kind: "local",
  });
});
