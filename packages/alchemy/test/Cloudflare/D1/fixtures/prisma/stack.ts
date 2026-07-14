import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Prisma from "@/Prisma/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Db } from "./db.ts";
import PrismaD1Worker from "./worker.ts";

/**
 * Prisma-over-D1 e2e stack: `Prisma.Schema` (generates migration SQL on
 * deploy) → `Cloudflare.D1.Database` (applies it via `migrationsDir`) →
 * a Worker querying through the generated Prisma client.
 */
export default Alchemy.Stack(
  "PrismaD1Stack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Prisma.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Db;
    const worker = yield* PrismaD1Worker;
    return { url: worker.url.as<string>() };
  }),
);
