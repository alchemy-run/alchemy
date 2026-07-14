import * as Cloudflare from "@/Cloudflare/index.ts";
import { d1 } from "@/Prisma/D1.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Db } from "./db.ts";
import { Widget } from "./effect.ts";
import { PrismaClient } from "./generated/client.ts";

/**
 * Worker that queries a D1 database through the generated Prisma client
 * (`@prisma/adapter-d1` under the hood). The client is built once per
 * execution scope by `Prisma.d1` from the raw `D1Database` binding exposed
 * by `Cloudflare.D1.QueryDatabase`.
 *
 *   POST /widgets — prisma.widget.create
 *   GET  /widgets — prisma.widget.findMany, decoded through the generated
 *                   effect/Schema `Widget` (from ./effect.ts) to prove the
 *                   alchemy-prisma-effect output validates live D1 rows
 */
export default class PrismaD1Worker extends Cloudflare.Worker<PrismaD1Worker>()(
  "PrismaD1Worker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const database = yield* Db;
    const db = yield* Cloudflare.D1.QueryDatabase(database);
    const prisma = yield* d1(PrismaClient, db.raw);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "POST" && url.pathname === "/widgets") {
          const body = (yield* request.json) as { name: string };
          const widget = yield* prisma.widget.create({
            data: { name: body.name },
          });
          return yield* HttpServerResponse.json({ widget });
        }

        if (request.method === "GET" && url.pathname === "/widgets") {
          const rows = yield* prisma.widget.findMany({
            orderBy: { id: "asc" },
          });
          const widgets = yield* Schema.decodeUnknownEffect(
            Schema.Array(Widget),
          )(rows);
          return yield* HttpServerResponse.json({ widgets });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        // Surface Prisma / schema-decode failures as a JSON 500 so the live
        // test can read the actual error instead of an opaque workerd
        // exception page.
        Effect.catchTag(["PrismaError", "SchemaError"], (e) =>
          HttpServerResponse.json({ error: String(e) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
