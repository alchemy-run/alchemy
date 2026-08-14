import * as Cloudflare from "alchemy/Cloudflare";
import * as PrismaPostgres from "alchemy/Prisma/ORM/Postgres";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "./Db.ts";
import type { Contract } from "./prisma/contract.d.ts";
import contractJson from "./prisma/contract.json" with { type: "json" };

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
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
        const request = yield* HttpServerRequest.HttpServerRequest;
        switch (request.method) {
          case "GET": {
            if (request.url === "/") {
              const users = yield* db.orm.public.User.all();
              return yield* HttpServerResponse.json({ users });
            }
            const id = request.url.split("/").pop() ?? "";
            const user = yield* db.orm.public.User.where({ id })
              .include("posts")
              .first();
            return yield* HttpServerResponse.json({ user });
          }
          case "POST": {
            const user = yield* db.orm.public.User.create({
              name: crypto.randomUUID(),
              email: crypto.randomUUID(),
            });
            return yield* HttpServerResponse.json({ user });
          }
          case "DELETE": {
            const id = request.url.split("/").pop() ?? "";
            const user = yield* db.orm.public.User.where({ id }).delete();
            return yield* HttpServerResponse.json({ user });
          }
          default: {
            return yield* HttpServerResponse.json(
              { error: "Method not allowed" },
              { status: 405 },
            );
          }
        }
      }).pipe(
        Effect.catch((cause: any) => {
          const peel = (e: any): any => (e?.cause ? peel(e.cause) : e);
          const root = peel(cause);
          return HttpServerResponse.json(
            {
              ok: false,
              error: String(cause),
              rootError: root?.message ?? String(root),
              rootCode: root?.code,
            },
            { status: 500 },
          );
        }),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
