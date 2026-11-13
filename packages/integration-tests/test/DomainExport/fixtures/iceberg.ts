/**
 * The Iceberg suites over one catalog: the store suite, the engine suite
 * with DuckDB reading the attached catalog, and the courtesy view, for a
 * catalog that serves views (or its absence, for one that does not). The
 * REST fixture runs in the release run; every other catalog only when a run
 * names the opt-in tag (`--tags export-lakes`).
 */
import type * as Export from "@alchemy.run/domain/Export";
import type * as DuckDb from "@alchemy.run/domain/Export/DuckDb";
import * as DuckDbEngine from "@alchemy.run/domain/Export/DuckDb";
import * as Iceberg from "@alchemy.run/domain/Export/Iceberg";
import { expect } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { SqlClient } from "effect/sql/SqlClient";
import { Ledger, pool, storeConformance } from "../../Domain/export-conformance/conformance.ts";
import { EngineLake, engineConformance } from "../../Domain/export-conformance/engines.ts";
import {
  call,
  decodeJson,
  dockerShrinks,
  exportSuite,
  lakesTag,
  type Request,
  runsOr,
  testTimeout,
} from "./docker.ts";
import { type CatalogKind, exportLayer, type Lake, startLake } from "./lake.ts";

export type LakeServices =
  | SqlClient
  | DuckDb.DuckDb
  | Iceberg.AttachedCatalog
  | HttpClient.HttpClient;

const Config = Schema.Struct({
  defaults: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  endpoints: Schema.optionalKey(Schema.Array(Schema.String)),
});
const Token = Schema.Struct({ access_token: Schema.String });
/** The part of a loaded Iceberg view these cases read: each version's SQL, and which is current. */
const LoadedView = Schema.Struct({
  metadata: Schema.Struct({
    "current-version-id": Schema.Number,
    versions: Schema.Array(
      Schema.Struct({
        "version-id": Schema.Number,
        representations: Schema.Array(Schema.Struct({ sql: Schema.String })),
      }),
    ),
  }),
});

const fetchJson = <S extends Schema.Top>(schema: S, url: string, request?: Request) =>
  call(url, request).pipe(Effect.flatMap(decodeJson(schema)));

/** The catalog as a hand-written client reaches it: its token (if any), config, and paths. */
export const catalogClient = (lake: Lake) =>
  Effect.gen(function* () {
    const { host, warehouse, auth } = lake.catalog;
    const token =
      auth?._tag === "OAuth2"
        ? (yield* fetchJson(Token, auth.serverUri ?? `${host}/v1/oauth/tokens`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: auth.clientId,
              client_secret: Redacted.value(auth.clientSecret),
              ...(auth.scope === undefined ? {} : { scope: auth.scope }),
            }).toString(),
          })).access_token
        : undefined;
    const headers: Record<string, string> =
      token === undefined ? {} : { authorization: `Bearer ${token}` };
    const config = yield* fetchJson(
      Config,
      `${host}/v1/config?warehouse=${encodeURIComponent(warehouse)}`,
      { headers },
    );
    // The REST spec's order (`defaults` under `overrides`); the segment is used as given.
    const prefix = config.overrides?.["prefix"] ?? config.defaults?.["prefix"];
    const base = `${host}/v1/${prefix === undefined ? "" : `${prefix}/`}`;
    return {
      headers,
      servesViews:
        config.endpoints?.includes("POST /v1/{prefix}/namespaces/{namespace}/views") ?? false,
      /** The SQL of a view's current version. */
      viewSql: (namespace: string, view: string) =>
        fetchJson(LoadedView, `${base}namespaces/${namespace}/views/${view}`, { headers }).pipe(
          Effect.map(
            ({ metadata }) =>
              metadata.versions.find((v) => v["version-id"] === metadata["current-version-id"])
                ?.representations[0]?.sql,
          ),
        ),
    };
  });

export interface IcebergSuiteOptions {
  /** The test file (`import.meta.url`), which owns the lake's stack. */
  readonly file: string;
  readonly catalog: CatalogKind;
  /** Whether the catalog serves Iceberg views: pinned, so a change in either direction fails. */
  readonly views: boolean;
  /** Generated sequences per property, unless `EXPORT_TEST_RUNS` says otherwise. */
  readonly storeRuns?: number;
  readonly engineRuns?: number;
}

export const icebergSuite = ({
  file,
  catalog,
  views,
  // Every Iceberg write is a catalog commit and every read a scan through the catalog; with the
  // reads the store suite makes after each sequence, about 15 seconds a sequence.
  storeRuns = 4,
  engineRuns = 15,
}: IcebergSuiteOptions) => {
  // Tier C: an opt-in tag, so a run that names nothing never builds the lake.
  const tags = {
    tags: ["local", "docker"],
    ...(catalog === "rest-fixture" ? {} : { optInTags: [lakesTag] }),
  };
  let lake: Lake | undefined;
  const environment = Layer.unwrap(
    Effect.gen(function* () {
      lake = (yield* startLake({ label: "Lake", file, catalog })).lake;
      return exportLayer(lake);
    }),
  );
  exportSuite(
    environment,
    `Domain Export Iceberg store and engine (${catalog} over MinIO)`,
    (it) => {
      const test = (name: string, effect: Effect.Effect<void, unknown, LakeServices>) =>
        it.effect(name, () => effect, { timeout: testTimeout, ...tags });
      storeConformance({
        test,
        make: Iceberg.store({ namespace: "conformance" }),
        kind: "local",
        runs: runsOr(storeRuns),
        maxShrinks: dockerShrinks,
      });
      engineConformance<LakeServices>({
        test,
        dialect: "duckdb",
        // Each evaluation writes under a fresh physical name; the store resolves its promoted generation.
        layer: (analytics, physical) =>
          analytics
            .toLayer(
              Effect.flatMap(Iceberg.names(EngineLake), (resolve) =>
                DuckDbEngine.engine({
                  name: (table) => resolve({ ...table, spec: { ...table.spec, name: physical() } }),
                }),
              ),
            )
            .pipe(Layer.provideMerge(EngineLake.toLayer(Iceberg.store({ namespace: "engines" })))),
        freshNames: true,
        kind: "local",
        runs: runsOr(engineRuns),
        maxShrinks: dockerShrinks,
      });
      it.effect(
        views
          ? "the catalog's view under the stable name follows each promotion"
          : "the catalog serves no views, and the store keeps none",
        () =>
          Effect.gen(function* () {
            const client = yield* catalogClient(lake!);
            expect(client.servesViews, "the catalog's advertised view endpoints").toBe(views);
            const store = yield* Iceberg.store({ namespace: "views" });
            const v0: Export.Spec.TableSpec = { ...Ledger.spec, name: "viewed" };
            const v1: Export.Spec.TableSpec = { ...v0, generation: 1 };
            const target = store.target(v0);
            const run = { rows: [pool[0]!], ingestedAt: DateTime.makeUnsafe(0) };
            yield* target.ensure(v0);
            yield* target.write(v0, run);
            if (!views) return;
            const sql = client.viewSql("views", "viewed");
            // Before any promotion, the view shows the first generation made.
            expect(yield* sql).toBe("SELECT * FROM views.viewed_v0");
            yield* target.ensure(v1);
            yield* target.write(v1, run);
            expect(yield* sql).toBe("SELECT * FROM views.viewed_v0");
            yield* target.promote(v1);
            expect(yield* sql).toBe("SELECT * FROM views.viewed_v1");
            yield* target.promote(v0);
            expect(yield* sql, "a second promotion moves it back").toBe(
              "SELECT * FROM views.viewed_v0",
            );
          }).pipe(Effect.provide(RuntimeContext.phantom)),
        { ...tags, timeout: testTimeout },
      );
    },
  );
};
