import * as Cloudflare from "@/Cloudflare/index.ts";
import { d1 } from "@/Prisma/D1.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Db } from "./db.ts";
import { PrismaClient } from "./generated/client.ts";

/**
 * Worker that queries a D1 database through the generated Prisma client
 * (`@prisma/adapter-d1` under the hood). The client is built once per
 * execution scope by `Prisma.d1` from the raw `D1Database` binding exposed
 * by `Cloudflare.D1.QueryDatabase`.
 *
 *   POST /widgets — prisma.widget.create
 *   GET  /widgets — prisma.widget.findMany
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
          const widgets = yield* prisma.widget.findMany({
            orderBy: { id: "asc" },
          });
          return yield* HttpServerResponse.json({ widgets });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        // Surface Prisma failures as a JSON 500 so the live test can read
        // the actual error instead of an opaque workerd exception page.
        Effect.catchTag("PrismaError", (e) =>
          HttpServerResponse.json({ error: e.message }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
