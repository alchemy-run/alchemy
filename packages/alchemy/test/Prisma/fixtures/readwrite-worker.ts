import * as Cloudflare from "@/Cloudflare/index.ts";
// Deep imports keep the Worker bundle lean: the `@/Prisma` barrel pulls in
// the local dev-database machinery (@prisma/dev -> pglite), which balloons
// the script and has no business inside a deployed Worker.
import {
  ReadWriteBucket,
  ReadWriteBucketBinding,
} from "@/Prisma/ReadWriteBucket.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestBucket } from "./bucket.ts";
import { readRoutes } from "./read-routes.ts";
import { writeRoutes } from "./write-routes.ts";

/**
 * Read + write access to the same Prisma bucket from a Cloudflare Worker.
 * A Worker carries no environment, so the binding takes the text-binding
 * branch of `makeBucketBinding` instead of the env branch the Compute apps
 * take — this fixture is what drives that branch end to end.
 */
export default class PrismaReadWriteBucketWorker extends Cloudflare.Worker<PrismaReadWriteBucketWorker>()(
  "PrismaReadWriteBucketWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* TestBucket;
    const store = yield* ReadWriteBucket(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const handled =
          (yield* writeRoutes(store, request, url)) ??
          (yield* readRoutes(store, url));
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(ReadWriteBucketBinding)),
) {}
