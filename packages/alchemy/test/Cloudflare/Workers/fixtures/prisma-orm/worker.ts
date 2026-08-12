import * as Cloudflare from "@/Cloudflare/index.ts";
import * as PrismaPostgres from "@/Prisma/ORM/Postgres.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Contract } from "./generated/contract.d.ts";
import contractJson from "./generated/contract.json";
import { Hyperdrive } from "./db.ts";

/**
 * Worker exercising the prisma-next runtime client on workerd. The client is
 * created once at init (no I/O — prisma-next connects lazily), and each fetch
 * event builds (and closes) its own `pg` pool against its per-event scope via
 * the execution memo. The test hammers the query routes sequentially and
 * concurrently to pin cross-request pool isolation: no "Cannot perform I/O on
 * behalf of a different request", no "Cannot use a pool after calling end".
 */
export default class PrismaOrmWorker extends Cloudflare.Worker<PrismaOrmWorker>()(
  "PrismaOrmWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* PrismaPostgres.Postgres<Contract>()(
      conn.connectionString,
      { contractJson },
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/widgets/create/")) {
          const name = request.url.split("/widgets/create/")[1] ?? "unnamed";
          const widget = yield* db
            .use((c) => c.orm.public.Widget.create({ name }))
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            id: widget.id,
            name: widget.name,
          });
        }

        if (request.url.startsWith("/widgets/get/")) {
          const id = Number(request.url.split("/widgets/get/")[1] ?? "0");
          const widget = yield* db
            .use((c) => c.orm.public.Widget.where({ id }).first())
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            found: widget !== null,
            name: widget?.name ?? null,
          });
        }

        if (request.url.startsWith("/widgets/tx/")) {
          const name = request.url.split("/widgets/tx/")[1] ?? "tx-widget";
          // Round-trip a transaction: create + read back inside one tx.
          const readBack = yield* db
            .use((c) =>
              c.transaction(async (tx) => {
                const created = await tx.orm.public.Widget.create({ name });
                return tx.orm.public.Widget.where({ id: created.id }).first();
              }),
            )
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            name: readBack?.name ?? null,
          });
        }

        if (request.url.startsWith("/widgets/error")) {
          // A query against a constraint that cannot exist — the typed
          // PrismaError tag must surface (not a defect).
          const outcome = yield* db
            .use((c) => c.orm.public.Widget.where({ id: Number.NaN }).first())
            .pipe(
              Effect.as("ok" as const),
              // Pins that the typed tag narrows the union — the remaining
              // channel (the connection source's own errors) dies.
              Effect.catchTag("Prisma.PrismaError", (error) =>
                Effect.succeed(`caught:${error._tag}` as const),
              ),
              Effect.orDie,
            );
          return HttpServerResponse.text(String(outcome));
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
