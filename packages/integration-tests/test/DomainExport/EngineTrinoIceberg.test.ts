/**
 * Tier B: the engine suite on Trino's Iceberg connector over the lake's REST
 * catalog. DuckDB writes through `Export.Iceberg.store`; Trino, deployed
 * with the lake, reads the promoted generation by its full name.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Docker from "@alchemy.run/docker";
import * as Export from "@alchemy.run/domain/Export";
import * as Iceberg from "@alchemy.run/domain/Export/Iceberg";
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  EngineLake,
  engineConformance,
  outsideReader,
} from "../Domain/export-conformance/engines.ts";
import {
  dockerShrinks,
  execIn,
  exportSuite,
  images,
  publish,
  runsOr,
  testTimeout,
  trino,
  waitFor,
} from "./fixtures/docker.ts";
import type { LakeServices } from "./fixtures/iceberg.ts";
import { exportLayer, startLake, trinoIcebergCatalog } from "./fixtures/lake.ts";

let trinoUrl = "";
let trinoContainer = "";

const environment = Layer.unwrap(
  Effect.gen(function* () {
    // Trino's catalog file, removed once the containers reading it are gone.
    const catalogs = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "alchemy-test-export-trino-"))),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );
    const trinoPublished = yield* publish(8080);
    const { lake, extra: engine } = yield* startLake({
      label: "Lake",
      file: import.meta.url,
      extra: (network) =>
        Docker.Container("Trino", {
          image: images.trino,
          volumes: [{ hostPath: catalogs, containerPath: "/etc/trino/catalog", readOnly: true }],
          ports: [trinoPublished.mapping],
          networks: [{ name: network }],
          start: true,
          cpus: 2,
          memory: "2g",
        }),
    });
    // The catalog file names the lake's addresses inside the network, known before Trino starts reading it.
    writeFileSync(join(catalogs, "iceberg.properties"), trinoIcebergCatalog(lake));
    trinoUrl = `http://127.0.0.1:${trinoPublished.port}`;
    trinoContainer = engine.name;
    yield* waitFor(
      "Trino",
      // A query that reads the catalog needs a worker; `SHOW CATALOGS` answers without one.
      trino(trinoUrl, "SELECT count(*) FROM iceberg.information_schema.schemata").pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    );
    return exportLayer(lake);
  }),
);

const tags = ["local", "docker"];

exportSuite(environment, "Domain Export engine (Trino over the Iceberg store)", (it) => {
  const test = (name: string, effect: Effect.Effect<void, unknown, LakeServices>) =>
    it.effect(name, () => effect, { timeout: testTimeout, tags });
  engineConformance<LakeServices>({
    test,
    dialect: "trino",
    // Each evaluation writes under a fresh physical name; the store resolves its promoted generation.
    layer: (analytics, physical) =>
      analytics
        .toLayer(
          Effect.flatMap(Iceberg.names(EngineLake, { catalog: "iceberg" }), (resolve) =>
            Export.Trino.engine({
              url: trinoUrl,
              user: "export",
              catalog: "iceberg",
              name: (table) => resolve({ ...table, spec: { ...table.spec, name: physical() } }),
            }),
          ),
        )
        .pipe(Layer.provideMerge(EngineLake.toLayer(Iceberg.store({ namespace: "engines" })))),
    freshNames: true,
    kind: "local",
    runs: runsOr(10),
    maxShrinks: dockerShrinks,
  });
  it.effect(
    "the engine's queries ran on Trino, against the Iceberg tables",
    () =>
      Effect.gen(function* () {
        // The engine names itself `alchemy-domain-export` on every query (`X-Trino-Source`).
        const finished = yield* trino(
          trinoUrl,
          "SELECT count(*) FROM system.runtime.queries WHERE source = 'alchemy-domain-export' AND state = 'FINISHED'",
        );
        expect(Number(finished[0]?.[0])).toBeGreaterThan(0);
        const tables = yield* trino(trinoUrl, "SHOW TABLES FROM iceberg.engines LIKE 'ledger_%'");
        expect(tables.length).toBeGreaterThan(0);
      }),
    { timeout: testTimeout, tags },
  );
  // By the stable name: the catalog's view, which the store moves on each promotion.
  outsideReader({
    test,
    label: "trino",
    // Trino reads a view only with its default catalog: the name Trino gives the lake.
    make: Iceberg.store({ namespace: "outside", viewCatalog: "iceberg" }),
    client: (name) =>
      execIn(trinoContainer, [
        "trino",
        "--output-format",
        "CSV_UNQUOTED",
        "--execute",
        `SELECT key, count(*) FROM iceberg.outside."${name}" GROUP BY key ORDER BY key`,
      ]),
    kind: "local",
  });
});
