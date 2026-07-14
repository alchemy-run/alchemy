import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Prisma from "@/Prisma/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Hyperdrive, NeonDb, Schema } from "./db.ts";
import PrismaWorker from "./worker.ts";

/**
 * Deploys a Prisma.Schema (generating migration SQL from `schema.prisma`), a
 * Neon project + branch migrated from that SQL, a Cloudflare Hyperdrive
 * pointed at the branch, and the {@link PrismaWorker} that queries it through
 * the generated Prisma client.
 */
export default Alchemy.Stack(
  "PrismaWorkerStack",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Neon.providers(),
      Prisma.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Schema;
    yield* NeonDb;
    yield* Hyperdrive;
    const worker = yield* PrismaWorker;
    return { url: worker.url.as<string>() };
  }),
);
