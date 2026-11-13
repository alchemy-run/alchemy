import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Export from "@alchemy.run/domain/Export";
import { afterAll, beforeAll, describe, it } from "@alchemy.run/test";
import { LibsqlClient } from "@effect/sql-libsql";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { storeConformance } from "./export-conformance/conformance.ts";

describe("Domain Export SQL store (SQLite)", { tags: ["unit", "local"] }, () => {
  /** One SQLite file for the suite, made when it starts and removed when it ends; each evaluation names tables of its own. */
  let directory = "";
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "export-sqlite-"));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const database = Layer.unwrap(
    Effect.sync(() => LibsqlClient.layer({ url: `file:${join(directory, "store.db")}` })),
  );
  storeConformance({
    test: (name, effect, options) =>
      it.effect(name, () => effect.pipe(Effect.provide(database)), options),
    make: Export.Sql.store({ name: "sqlite" }),
    kind: "local",
  });
});
