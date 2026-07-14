import * as Cloudflare from "@/Cloudflare/index.ts";
import { postgres } from "@/Prisma/Postgres.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "./db.ts";
import { PrismaClient } from "./generated/client.ts";

/**
 * Worker that queries a Neon Postgres database through the generated Prisma
 * client over a Hyperdrive connection. `Prisma.postgres` defers the client
 * (and its pg pool) to the first query of each event and closes it when the
 * event's scope settles — so sequential requests must never observe a prior
 * event's closed pool.
 *
 * Routes:
 * - `PUT /widgets/:name` — upsert a widget by name, returns the row as JSON.
 * - `GET /widgets/:name` — read a widget by name, returns `{ widget }`.
 */
export default class PrismaWorker extends Cloudflare.Worker<PrismaWorker>()(
  "PrismaWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const prisma = yield* postgres(PrismaClient, conn.connectionString);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/widgets/")) {
          const name = decodeURIComponent(
            request.url.slice("/widgets/".length),
          );

          if (request.method === "PUT") {
            const widget = yield* prisma.widget
              .upsert({
                where: { name },
                create: { name },
                update: {},
              })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ ok: true, widget });
          }

          const widget = yield* prisma.widget
            .findUnique({ where: { name } })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true, widget });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
