import * as Cloudflare from "@alchemy.run/cloudflare";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { WAREHOUSES, warehouseLookup } from "./bindings.ts";

const BindingsWarehouse = warehouseLookup(WAREHOUSES.discovery);

const { Discovery } = StarburstGalaxy;

/** A Worker that reads and documents the warehouse through every Discovery binding. */
export default class GalaxyDiscoveryWorker extends Cloudflare.Worker<GalaxyDiscoveryWorker>()(
  "GalaxyDiscoveryWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const getCatalogMetadata = yield* Discovery.GetCatalogMetadata(BindingsWarehouse);
    const listCatalogSchemas = yield* Discovery.ListCatalogSchemas(BindingsWarehouse);
    const getCatalogSchema = yield* Discovery.GetCatalogSchema(BindingsWarehouse);
    const listCatalogSchemaTables = yield* Discovery.ListCatalogSchemaTables(BindingsWarehouse);
    const getCatalogSchemaTable = yield* Discovery.GetCatalogSchemaTable(BindingsWarehouse);
    const listColumns = yield* Discovery.ListCatalogSchemaTableColumns(BindingsWarehouse);
    const getColumn = yield* Discovery.GetCatalogSchemaTableColumn(BindingsWarehouse);
    const updateColumn = yield* Discovery.UpdateCatalogSchemaTableColumn(BindingsWarehouse);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const table = { schemaName: "sales", tableName: "orders" };

        if (url.pathname === "/catalog") {
          const metadata = yield* getCatalogMetadata();
          const schemas = yield* listCatalogSchemas();
          const schema = yield* getCatalogSchema({ schemaName: "sales" });
          const tables = yield* listCatalogSchemaTables({ schemaName: "sales" });
          const orders = yield* getCatalogSchemaTable(table);
          const columns = yield* listColumns(table);
          const amount = yield* getColumn({ ...table, columnName: "amount" });
          return yield* HttpServerResponse.json({
            catalogId: metadata.catalogId,
            catalogName: metadata.catalogName,
            schemas: schemas.map((s) => s.schemaId),
            schema: schema.schemaId,
            tables: tables.map((t) => t.tableId),
            tableType: orders.tableType,
            columns: columns.map((c) => c.columnId),
            amountType: amount.dataType,
          });
        }

        if (url.pathname === "/describe") {
          const description = url.searchParams.get("text") ?? "";
          const column = yield* updateColumn({ ...table, columnName: "customer", description });
          return yield* HttpServerResponse.json({ description: column.description });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        // Answer failures with the cause so a failing test shows it.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Discovery.GetCatalogMetadataHttp,
        Discovery.ListCatalogSchemasHttp,
        Discovery.GetCatalogSchemaHttp,
        Discovery.ListCatalogSchemaTablesHttp,
        Discovery.GetCatalogSchemaTableHttp,
        Discovery.ListCatalogSchemaTableColumnsHttp,
        Discovery.GetCatalogSchemaTableColumnHttp,
        Discovery.UpdateCatalogSchemaTableColumnHttp,
      ),
    ),
  ),
) {}
