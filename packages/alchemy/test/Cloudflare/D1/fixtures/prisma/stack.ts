import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Prisma from "@/Prisma/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as pathe from "pathe";
import { Db } from "./db.ts";
import PrismaD1Worker from "./worker.ts";

/**
 * Prisma-over-D1 e2e stack: `Prisma.Schema` (generates migration SQL on
 * deploy) → `Cloudflare.D1.Database` (applies it via `migrationsDir`) →
 * two Workers querying through the generated Prisma client:
 *
 * - `worker.ts` — Effect worker using the `Prisma.d1` runtime client;
 * - `async-worker.ts` — plain async worker constructing the client directly
 *   from the native `env.DB` binding with `new PrismaD1(env.DB)`.
 */
export default Alchemy.Stack(
  "PrismaD1Stack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Prisma.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const database = yield* Db;
    const worker = yield* PrismaD1Worker;
    // The async worker binds the root database handle on `env`, so it
    // queries the same migrated database the stack owns.
    const asyncWorker = yield* Cloudflare.Worker("PrismaD1AsyncWorker", {
      main: pathe.resolve(import.meta.dirname, "async-worker.ts"),
      env: {
        DB: database,
      },
    });
    return {
      url: worker.url.as<string>(),
      asyncUrl: asyncWorker.url.as<string>(),
    };
  }),
);
